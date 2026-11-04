import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import type { Database, Order, OrderActorType, PriceTier } from '../../db/schema.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import type { CurrentCustomer } from '../customer-auth/customer-session.js';
import { enqueueEmail } from '../email/outbox.js';
import { orderPlacedEmail, orderStatusEmail } from '../email/templates.js';
import { type CartItemInput, priceCart, shippingFeeFor } from './cart-pricing.js';
import { type AdminOrderAction, assertTransition, customerCanCancel } from './order-state.js';

type Trx = Transaction<Database>;

export interface CreateOrderInput {
  items: CartItemInput[];
  contact: { fullName: string; phone: string; email: string };
  shippingAddress: { province: string; ward: string; addressLine: string };
  note: string | null;
  requestInvoice: boolean;
  /** The total the customer saw on the checkout page. If the server's total differs, nothing is created. */
  expectedTotal: number;
}

export interface Actor {
  type: OrderActorType;
  id: string | null;
}

// ---------- helpers ----------

/** e.g. DTT-261104-K7Q2MX. No 0/O/1/I to avoid confusion when read over the phone. */
function generateOrderCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const now = new Date();
  const date = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  let random = '';
  for (let i = 0; i < 6; i++) random += alphabet[randomInt(alphabet.length)];
  return `DTT-${date}-${random}`;
}

/** Stable hash of the request, so "same key + same body" can be told apart from "same key + different body". */
function hashRequest(customerId: string | null, input: CreateOrderInput): string {
  return createHash('sha256').update(JSON.stringify({ customerId, ...input })).digest('hex');
}

async function addEvent(trx: Trx, order: Pick<Order, 'id' | 'order_status' | 'payment_status' | 'fulfillment_status'>, actor: Actor, action: string, note?: string | null) {
  await trx
    .insertInto('order_events')
    .values({
      order_id: order.id,
      actor_type: actor.type,
      actor_id: actor.id,
      action,
      order_status: order.order_status,
      payment_status: order.payment_status,
      fulfillment_status: order.fulfillment_status,
      note: note ?? null,
    })
    .execute();
}

/**
 * Put the items of an order back in stock. Runs at most once per order: the UPDATE only matches
 * while stock_restored_at is still empty, so a repeated cancel (double click, retry) does nothing.
 */
async function restockOrderOnce(trx: Trx, orderId: string, reason: 'order_cancelled' | 'order_returned', adminId: string | null) {
  const claimed = await trx
    .updateTable('orders')
    .set({ stock_restored_at: sql`now()` })
    .where('id', '=', orderId)
    .where('stock_restored_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!claimed) return;

  const items = await trx.selectFrom('order_items').select(['variant_id', 'quantity']).where('order_id', '=', orderId).orderBy('variant_id').execute();
  for (const item of items) {
    const updated = await trx
      .updateTable('product_variants')
      .set({ stock: sql`stock + ${item.quantity}`, updated_at: sql`now()` })
      .where('id', '=', item.variant_id)
      .returning('stock')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('inventory_movements')
      .values({ variant_id: item.variant_id, change: item.quantity, stock_after: updated.stock, reason, order_id: orderId, admin_user_id: adminId })
      .execute();
  }
}

// ---------- create ----------

export async function createOrder(
  db: Db,
  env: Env,
  params: { idempotencyKey: string; customer: CurrentCustomer | null; tier: PriceTier; input: CreateOrderInput },
): Promise<{ order: Order; accessToken: string | null; replayed: boolean }> {
  const { idempotencyKey, customer, tier, input } = params;
  const requestHash = hashRequest(customer?.id ?? null, input);

  if (input.requestInvoice && !(customer?.accountType === 'business' && customer.companyName && customer.taxCode && customer.invoiceAddress)) {
    throw badRequest('Chỉ tài khoản doanh nghiệp có đủ thông tin xuất hóa đơn mới yêu cầu được hóa đơn.');
  }

  return db.transaction().execute(async (trx) => {
    // 1. Claim the idempotency key. If another request with the same key is still running, this
    //    INSERT waits for it to finish; then it conflicts and we return that request's order.
    const claimed = await trx
      .insertInto('idempotency_keys')
      .values({ scope: 'order_create', key: idempotencyKey, request_hash: requestHash })
      .onConflict((oc) => oc.columns(['scope', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();

    if (!claimed) {
      const existing = await trx
        .selectFrom('idempotency_keys')
        .select(['request_hash', 'order_id'])
        .where('scope', '=', 'order_create')
        .where('key', '=', idempotencyKey)
        .executeTakeFirstOrThrow();
      if (existing.request_hash !== requestHash || !existing.order_id) {
        // Different body with the same key: refuse, and do not reveal anything about the other order.
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Yêu cầu đặt hàng không hợp lệ. Vui lòng tải lại trang và thử lại.');
      }
      const order = await trx.selectFrom('orders').selectAll().where('id', '=', existing.order_id).executeTakeFirstOrThrow();
      return { order, accessToken: null, replayed: true };
    }

    // 2. Price the cart with the variants locked, so stock cannot change until we commit.
    const cart = await priceCart(trx, input.items, tier, { lockVariants: true });
    if (cart.problems.length > 0) {
      throw new AppError(409, 'OUT_OF_STOCK', 'Một số sản phẩm đã hết hàng hoặc không còn bán. Vui lòng kiểm tra lại giỏ hàng.', cart.problems);
    }
    const shippingFee = await shippingFeeFor(trx, cart.subtotal);
    const total = cart.subtotal + shippingFee;

    // 3. The customer must have seen the same total. Otherwise send the new prices back for review.
    if (total !== input.expectedTotal) {
      throw new AppError(409, 'PRICE_CHANGED', 'Giá hoặc phí giao hàng đã thay đổi. Vui lòng xem lại đơn trước khi đặt.', {
        priceTier: cart.priceTier,
        lines: cart.lines,
        subtotal: cart.subtotal,
        shippingFee,
        total,
      });
    }

    // 4. Take the stock. The rows are locked and were checked above; the CHECK (stock >= 0) is a last safety net.
    const takenPerVariant = new Map<string, number>();
    for (const line of cart.lines) takenPerVariant.set(line.variantId, (takenPerVariant.get(line.variantId) ?? 0) + line.quantity);

    const accessToken = generateToken();
    const order = await trx
      .insertInto('orders')
      .values({
        code: generateOrderCode(),
        customer_id: customer?.id ?? null,
        customer_name: input.contact.fullName,
        phone: input.contact.phone,
        email: input.contact.email,
        shipping_province: input.shippingAddress.province,
        shipping_ward: input.shippingAddress.ward,
        shipping_address_line: input.shippingAddress.addressLine,
        note: input.note,
        price_tier: cart.priceTier,
        invoice_requested: input.requestInvoice,
        invoice_company_name: input.requestInvoice ? customer!.companyName : null,
        invoice_tax_code: input.requestInvoice ? customer!.taxCode : null,
        invoice_address: input.requestInvoice ? customer!.invoiceAddress : null,
        subtotal: cart.subtotal,
        shipping_fee: shippingFee,
        total,
        access_token_hash: hashToken(accessToken),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (const [variantId, quantity] of takenPerVariant) {
      const updated = await trx
        .updateTable('product_variants')
        .set({ stock: sql`stock - ${quantity}`, updated_at: sql`now()` })
        .where('id', '=', variantId)
        .returning('stock')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('inventory_movements')
        .values({ variant_id: variantId, change: -quantity, stock_after: updated.stock, reason: 'order_placed', order_id: order.id })
        .execute();
    }

    // 5. Snapshot of every line exactly as sold.
    await trx
      .insertInto('order_items')
      .values(
        cart.lines.map((line) => ({
          order_id: order.id,
          variant_id: line.variantId,
          product_id: line.productId,
          product_name: line.productName,
          variant_name: line.variantName,
          sku: line.sku,
          options: JSON.stringify(line.options),
          image_url: line.imageUrl,
          unit_price: line.unitPrice,
          extra_beads: line.extraBeads,
          extra_bead_unit_price: line.extraBeadUnitPrice,
          quantity: line.quantity,
          line_total: line.lineTotal,
        })),
      )
      .execute();

    await addEvent(trx, order, { type: customer ? 'customer' : 'guest', id: customer?.id ?? null }, 'order_placed');
    await trx.updateTable('idempotency_keys').set({ order_id: order.id }).where('scope', '=', 'order_create').where('key', '=', idempotencyKey).execute();

    // 6. Confirmation email goes into the outbox in this same transaction: sending happens later.
    const appUrl = env.APP_PUBLIC_URL.replace(/\/$/, '');
    const tokenParam = `token=${encodeURIComponent(accessToken)}`;
    await enqueueEmail(
      trx,
      orderPlacedEmail(
        {
          code: order.code,
          customerName: order.customer_name,
          email: order.email,
          items: cart.lines,
          subtotal: order.subtotal,
          shippingFee: order.shipping_fee,
          total: order.total,
          shippingAddress: `${order.shipping_address_line}, ${order.shipping_ward}, ${order.shipping_province}`,
        },
        `${appUrl}/don-hang/${order.code}?${tokenParam}`,
        `${appUrl}/don-hang/${order.code}?${tokenParam}&action=cancel`,
      ),
    );

    return { order, accessToken, replayed: false };
  });
}

// ---------- read ----------

export async function getOrderItems(db: Db, orderId: string) {
  return db
    .selectFrom('order_items')
    .select(['product_name', 'variant_name', 'sku', 'options', 'image_url', 'unit_price', 'extra_beads', 'extra_bead_unit_price', 'quantity', 'line_total'])
    .where('order_id', '=', orderId)
    .orderBy('id')
    .execute();
}

/** What the customer sees about their own order. `full` adds the address (only with the secret link or the account). */
export async function customerOrderView(db: Db, order: Order, full: boolean) {
  const items = await getOrderItems(db, order.id);
  return {
    code: order.code,
    createdAt: order.created_at,
    orderStatus: order.order_status,
    paymentStatus: order.payment_status,
    fulfillmentStatus: order.fulfillment_status,
    paymentMethod: order.payment_method,
    priceTier: order.price_tier,
    customerName: order.customer_name,
    carrier: order.carrier,
    trackingNumber: order.tracking_number,
    subtotal: order.subtotal,
    shippingFee: order.shipping_fee,
    discountTotal: order.discount_total,
    total: order.total,
    canCancel: customerCanCancel(order),
    items: items.map((item) => ({
      productName: item.product_name,
      variantName: item.variant_name,
      sku: item.sku,
      options: item.options,
      imageUrl: item.image_url,
      unitPrice: item.unit_price,
      extraBeads: item.extra_beads,
      extraBeadUnitPrice: item.extra_bead_unit_price,
      quantity: item.quantity,
      lineTotal: item.line_total,
    })),
    shipping: full
      ? {
          phone: order.phone,
          email: order.email,
          province: order.shipping_province,
          ward: order.shipping_ward,
          addressLine: order.shipping_address_line,
          note: order.note,
        }
      : { province: order.shipping_province },
    invoice: full && order.invoice_requested
      ? { companyName: order.invoice_company_name, taxCode: order.invoice_tax_code, address: order.invoice_address }
      : null,
  };
}

/** Guest access with the secret token from the confirmation email. */
export async function findOrderByAccessToken(db: Db, code: string, token: string): Promise<Order> {
  const order = await db.selectFrom('orders').selectAll().where('code', '=', code.toUpperCase()).executeTakeFirst();
  const ok = order && timingSafeEqual(order.access_token_hash, hashToken(token));
  if (!order || !ok) throw notFound('Không tìm thấy đơn hàng hoặc liên kết không hợp lệ.');
  return order;
}

// ---------- cancel by customer ----------

export async function cancelByCustomer(db: Db, orderId: string, actor: Actor, reason: string | null): Promise<Order> {
  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirstOrThrow();
    // Already cancelled (double click, retried request): answer with the current state, change nothing.
    if (order.order_status === 'cancelled') return order;
    if (!customerCanCancel(order)) {
      throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Đơn hàng đã được cửa hàng xác nhận nên không thể tự hủy. Vui lòng liên hệ cửa hàng.');
    }

    const updated = await trx
      .updateTable('orders')
      .set({ order_status: 'cancelled', cancel_reason: reason ?? 'Khách hủy đơn', cancelled_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await restockOrderOnce(trx, orderId, 'order_cancelled', null);
    await addEvent(trx, updated, actor, 'cancelled_by_customer', reason);
    return updated;
  });
}

// ---------- admin actions ----------

export interface AdminActionInput {
  action: AdminOrderAction;
  carrier?: string;
  trackingNumber?: string;
  reason?: string;
  note?: string;
}

export async function applyAdminAction(db: Db, orderId: string, input: AdminActionInput, adminId: string): Promise<Order> {
  return db.transaction().execute(async (trx) => {
    // Lock the order: two admins clicking at the same time are handled one after the other.
    const order = await trx.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
    if (!order) throw notFound('Không tìm thấy đơn hàng.');

    const transition = assertTransition(input.action, order);
    const next = transition.next(order);

    if (input.action === 'ship' && (!input.carrier || !input.trackingNumber)) {
      throw badRequest('Vui lòng nhập đơn vị vận chuyển và mã vận đơn.');
    }
    if ((input.action === 'cancel' || input.action === 'mark_returned') && !input.reason) {
      throw badRequest('Vui lòng nhập lý do.');
    }

    const now = sql<Date>`now()`;
    const timestamps = {
      confirm: { confirmed_at: now },
      ship: { shipped_at: now, carrier: input.carrier ?? null, tracking_number: input.trackingNumber ?? null },
      deliver: { delivered_at: now },
      mark_paid: { paid_at: now },
      complete: { completed_at: now },
      cancel: { cancelled_at: now, cancel_reason: input.reason ?? null },
      mark_returned: { cancelled_at: now, cancel_reason: input.reason ?? null },
      start_packing: {},
      mark_refunded: {},
    }[input.action];

    const updated = await trx
      .updateTable('orders')
      .set({ ...next, ...timestamps, updated_at: sql`now()` })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (transition.restock) {
      await restockOrderOnce(trx, orderId, input.action === 'mark_returned' ? 'order_returned' : 'order_cancelled', adminId);
    }
    await addEvent(trx, updated, { type: 'admin', id: adminId }, input.action, input.reason ?? input.note ?? null);

    // Tell the customer about the steps they care about.
    const messages: Partial<Record<AdminOrderAction, string>> = {
      confirm: 'Cửa hàng đã xác nhận đơn hàng của bạn và đang chuẩn bị hàng.',
      ship: `Đơn hàng đã được giao cho ${updated.carrier}. Mã vận đơn: ${updated.tracking_number}.`,
      cancel: `Đơn hàng đã bị hủy. Lý do: ${updated.cancel_reason}.`,
    };
    const message = messages[input.action];
    if (message) await enqueueEmail(trx, orderStatusEmail(updated.email, updated.code, message));

    return updated;
  });
}

// ---------- admin: edit contact / shipping details ----------

export interface OrderDetailsInput {
  customerName?: string;
  phone?: string;
  email?: string;
  shippingProvince?: string;
  shippingWard?: string;
  shippingAddressLine?: string;
  note?: string | null;
  reason: string;
}

const EDITABLE_FIELDS = {
  customerName: { column: 'customer_name', label: 'Tên người nhận' },
  phone: { column: 'phone', label: 'Số điện thoại' },
  email: { column: 'email', label: 'Email' },
  shippingProvince: { column: 'shipping_province', label: 'Tỉnh/thành' },
  shippingWard: { column: 'shipping_ward', label: 'Phường/xã' },
  shippingAddressLine: { column: 'shipping_address_line', label: 'Địa chỉ' },
  note: { column: 'note', label: 'Ghi chú' },
} as const;

/**
 * The customer called to change their phone or address. Allowed until the parcel leaves the shop.
 * Items and money are never changed here: cancel and re-order for that.
 */
export async function updateOrderDetails(db: Db, orderId: string, input: OrderDetailsInput, adminId: string): Promise<Order> {
  return db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
    if (!order) throw notFound('Không tìm thấy đơn hàng.');

    const editable =
      (order.order_status === 'pending' || order.order_status === 'confirmed') &&
      (order.fulfillment_status === 'unfulfilled' || order.fulfillment_status === 'packing');
    if (!editable) {
      throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Đơn đã giao cho vận chuyển hoặc đã kết thúc, không thể sửa thông tin nhận hàng.');
    }

    // New values: what the admin sent, or the current value when a field was not sent.
    const next = {
      customer_name: input.customerName ?? order.customer_name,
      phone: input.phone ?? order.phone,
      email: input.email ?? order.email,
      shipping_province: input.shippingProvince ?? order.shipping_province,
      shipping_ward: input.shippingWard ?? order.shipping_ward,
      shipping_address_line: input.shippingAddressLine ?? order.shipping_address_line,
      note: input.note !== undefined ? input.note : order.note,
    };
    const descriptions = Object.values(EDITABLE_FIELDS)
      .filter((field) => next[field.column] !== order[field.column])
      .map((field) => `${field.label}: "${order[field.column] ?? ''}" → "${next[field.column] ?? ''}"`);
    if (descriptions.length === 0) return order;

    const updated = await trx
      .updateTable('orders')
      .set({ ...next, updated_at: sql`now()` })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
    // History keeps both the reason and the old → new values.
    await addEvent(trx, updated, { type: 'admin', id: adminId }, 'details_updated', `${input.reason}. ${descriptions.join('; ')}`);
    return updated;
  });
}
