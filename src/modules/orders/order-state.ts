import type { FulfillmentStatus, Order, OrderStatus, PaymentStatus } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';

// All allowed status changes in one table. The admin UI shows only the actions that `availableActions`
// returns, and the API refuses anything else, even when called directly.
//
//   order:        pending → confirmed → completed          (or → cancelled)
//   fulfillment:  unfulfilled → packing → shipped → delivered   (or shipped/delivered → returned)
//   payment:      unpaid → paid (COD collected after delivery) → refunded (only for cancelled orders)
//
// "delivered" never sets "paid" automatically (D4): the admin records the COD payment separately.

export type AdminOrderAction =
  | 'confirm'
  | 'start_packing'
  | 'ship'
  | 'deliver'
  | 'mark_paid'
  | 'complete'
  | 'cancel'
  | 'mark_returned'
  | 'mark_refunded';

type StatusSnapshot = Pick<Order, 'order_status' | 'payment_status' | 'fulfillment_status'>;

interface Transition {
  allowed: (o: StatusSnapshot) => boolean;
  next: (o: StatusSnapshot) => { order_status: OrderStatus; payment_status: PaymentStatus; fulfillment_status: FulfillmentStatus };
  restock?: boolean;
  label: string;
}

export const TRANSITIONS: Record<AdminOrderAction, Transition> = {
  confirm: {
    label: 'Xác nhận đơn',
    allowed: (o) => o.order_status === 'pending',
    next: (o) => ({ ...o, order_status: 'confirmed' }),
  },
  start_packing: {
    label: 'Bắt đầu đóng gói',
    allowed: (o) => o.order_status === 'confirmed' && o.fulfillment_status === 'unfulfilled',
    next: (o) => ({ ...o, fulfillment_status: 'packing' }),
  },
  ship: {
    label: 'Giao cho đơn vị vận chuyển',
    allowed: (o) => o.order_status === 'confirmed' && o.fulfillment_status === 'packing',
    next: (o) => ({ ...o, fulfillment_status: 'shipped' }),
  },
  deliver: {
    label: 'Đã giao hàng',
    allowed: (o) => o.order_status === 'confirmed' && o.fulfillment_status === 'shipped',
    next: (o) => ({ ...o, fulfillment_status: 'delivered' }),
  },
  mark_paid: {
    label: 'Đã thu tiền COD',
    allowed: (o) => o.order_status === 'confirmed' && o.fulfillment_status === 'delivered' && o.payment_status === 'unpaid',
    next: (o) => ({ ...o, payment_status: 'paid' }),
  },
  complete: {
    label: 'Hoàn tất đơn',
    allowed: (o) => o.order_status === 'confirmed' && o.fulfillment_status === 'delivered' && o.payment_status === 'paid',
    next: (o) => ({ ...o, order_status: 'completed' }),
  },
  cancel: {
    label: 'Hủy đơn',
    allowed: (o) =>
      (o.order_status === 'pending' || o.order_status === 'confirmed') &&
      (o.fulfillment_status === 'unfulfilled' || o.fulfillment_status === 'packing'),
    next: (o) => ({ ...o, order_status: 'cancelled', fulfillment_status: 'unfulfilled' }),
    restock: true,
  },
  mark_returned: {
    label: 'Hàng bị hoàn về',
    allowed: (o) => o.order_status === 'confirmed' && (o.fulfillment_status === 'shipped' || o.fulfillment_status === 'delivered'),
    next: (o) => ({ ...o, order_status: 'cancelled', fulfillment_status: 'returned' }),
    restock: true,
  },
  mark_refunded: {
    label: 'Đã hoàn tiền',
    allowed: (o) => o.order_status === 'cancelled' && o.payment_status === 'paid',
    next: (o) => ({ ...o, payment_status: 'refunded' }),
  },
};

export function availableActions(order: StatusSnapshot): AdminOrderAction[] {
  return (Object.keys(TRANSITIONS) as AdminOrderAction[]).filter((action) => TRANSITIONS[action].allowed(order));
}

export function assertTransition(action: AdminOrderAction, order: StatusSnapshot): Transition {
  const transition = TRANSITIONS[action];
  if (!transition.allowed(order)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `Không thể "${transition.label}" ở trạng thái hiện tại của đơn.`, {
      orderStatus: order.order_status,
      paymentStatus: order.payment_status,
      fulfillmentStatus: order.fulfillment_status,
      availableActions: availableActions(order),
    });
  }
  return transition;
}

/** Customers (guest link or account) may cancel only before the shop has confirmed the order. */
export function customerCanCancel(order: StatusSnapshot): boolean {
  return order.order_status === 'pending' && order.fulfillment_status === 'unfulfilled';
}
