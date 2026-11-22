export interface TopUpRequest {
  orderId: string;
  accountId: string;
  amount: string;
  userId: number;
}

export interface TopUpResult {
  success: boolean;
  message: string;
}

export interface PaymentProvider {
  name: string;
  processTopUp(request: TopUpRequest): Promise<TopUpResult>;
}
