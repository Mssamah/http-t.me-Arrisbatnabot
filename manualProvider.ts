import { PaymentProvider, TopUpRequest, TopUpResult } from './baseProvider';

export class ManualProvider implements PaymentProvider {
  name = 'Manual Agent Provider';

  async processTopUp(request: TopUpRequest): Promise<TopUpResult> {
    // In manual mode, the agent executes the transfer in their official MobCash dashboard
    // before clicking the Approve button in Telegram.
    return {
      success: true,
      message: `تم تأكيد شحن الحساب ${request.accountId} بمبلغ ${request.amount} يدوياً بنجاح.`
    };
  }
}
