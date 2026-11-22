import { PaymentProvider, TopUpRequest, TopUpResult } from './baseProvider';

export class ManualProvider implements PaymentProvider {
  name = 'Manual Agent Provider';

  async processTopUp(request: TopUpRequest): Promise<TopUpResult> {
    return {
      success: true,
      message: `تم تأكيد شحن الحساب ${request.accountId} بمبلغ ${request.amount} يدوياً بنجاح.`
    };
  }
}
