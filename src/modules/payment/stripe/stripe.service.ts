import { Injectable, Logger } from '@nestjs/common';
import { StripePayment } from '../../../common/lib/Payment/stripe/StripePayment';
import { PrismaService } from '../../../prisma/prisma.service';
import { SubscriptionPlan } from '@prisma/client';
import appConfig from '../../../config/app.config';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(private prisma: PrismaService) {}

  async handleWebhook(rawBody: string, sig: string | string[]) {
    const event = StripePayment.handleWebhook(rawBody, sig);

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.handleSubscriptionUpdate(event.data.object as any);
        break;
      default:
        this.logger.log(`Unhandled event type ${event.type}`);
    }

    return { received: true };
  }

  private async handleSubscriptionUpdate(subscription: any) {
    console.log('Handling subscription update:', subscription);

    const customerId = subscription.customer;
    const status = subscription.status;
    const stripeSubId = subscription.id;

    let currentPeriodEnd: Date | undefined;
    if (subscription.current_period_end) {
      currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    } else if (subscription.items?.data?.[0]?.current_period_end) {
      currentPeriodEnd = new Date(subscription.items.data[0].current_period_end * 1000);
    } else if (subscription.ended_at) {
      currentPeriodEnd = new Date(subscription.ended_at * 1000);
    }

    // Ensure date is valid
    if (currentPeriodEnd && isNaN(currentPeriodEnd.getTime())) {
      currentPeriodEnd = undefined;
    }

    // Find user by billing_id
    const user = await this.prisma.user.findFirst({
      where: { billing_id: customerId },
    });

    if (!user) {
      this.logger.error(`User not found for customer ID: ${customerId}`);
      return;
    }

    // Find existing subscription by Stripe ID or User ID
    const existingSub = await this.prisma.subscription.findFirst({
      where: {
        OR: [{ stripeSubId: stripeSubId }, { userId: user.id }],
      },
    });

    if (existingSub) {
      const isActive = status === 'active' || status === 'trialing';

      const updateData: any = {
        status: status,
        isActive: isActive,
        stripeSubId: stripeSubId, // Ensure ID is linked
        updatedAt: new Date(),
      };

      if (currentPeriodEnd) {
        updateData.endDate = currentPeriodEnd;
      }

      await this.prisma.subscription.update({
        where: { id: existingSub.id },
        data: updateData,
      });

      // Update User Plan Status
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          plan: isActive ? 'PRO' : 'FREE',
        },
      });

      this.logger.log(
        `Updated subscription for user ${user.id} to status: ${status}`,
      );
    }
  }
}
