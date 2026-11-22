export interface OrderSession {
  step?: 'awaiting_account_id' | 'awaiting_amount' | 'awaiting_receipt';
  accountId?: string;
  amount?: string;
}

export interface OrderRecord {
  id: string;
  userId: number;
  accountId: string;
  amount: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
}

class MemoryStore {
  private sessions = new Map<number, OrderSession>();
  private orders = new Map<string, OrderRecord>();

  getSession(userId: number): OrderSession {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {});
    }
    return this.sessions.get(userId)!;
  }

  clearSession(userId: number): void {
    this.sessions.delete(userId);
  }

  saveOrder(order: OrderRecord): void {
    this.orders.set(order.id, order);
  }

  getOrder(orderId: string): OrderRecord | undefined {
    return this.orders.get(orderId);
  }

  updateOrderStatus(orderId: string, status: 'approved' | 'rejected'): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = status;
    }
  }
}

export const store = new MemoryStore();
