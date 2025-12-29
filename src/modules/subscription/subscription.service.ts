import { Injectable, BadRequestException } from '@nestjs/common';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { StripePayment } from '../../common/lib/Payment/stripe/StripePayment';
import appConfig from '../../config/app.config';
import { SubscriptionPlan } from '@prisma/client';
import { CreateProductAndPriceDto } from './dto/createProductAndPrice.dto';
import { AddCardDto } from './dto/AddCardDto.dto';
import { NotificationRepository } from '../../common/repository/notification/notification.repository';

@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  async getSubscriptionStatus(userId: string) {
    const now = new Date();

    const subscription = await this.prisma.subscription.findFirst({
      where: { userId: userId },
      orderBy: [
        { isActive: 'desc' },
        { endDate: 'desc' },
        { createdAt: 'desc' },
      ],
      include: {
        plan: true,
      },
    });

    // 2. No subscription record found -> New User / Free Tier
    if (!subscription) {
      return {
        success: false,
        plan: SubscriptionPlan.FREE,
        status: 'inactive',
        message: 'No subscription found.',
      };
    }

    // 3. Inactive Subscription
    if (!subscription.isActive) {
      return {
        success: false,
        plan: SubscriptionPlan.FREE,
        status: subscription.status || 'inactive',
        subscription: subscription,
      };
    }

    // 4. Check for Expiration
    const isExpired = subscription.endDate && now > subscription.endDate;

    if (isExpired) {
      if (subscription.isActive) {
        await this.prisma.$transaction([
          this.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              isActive: false,
              status: 'expired',
              remainingDays: 0,
            },
          }),
          this.prisma.user.update({
            where: { id: userId },
            data: { plan: 'FREE' },
          }),
        ]);
      }

      return {
        success: false,
        plan: SubscriptionPlan.FREE,
        status: 'expired',
        subscription: { ...subscription, isActive: false, status: 'expired' },
      };
    }

    // 5. Active Subscription Logic
    let remainingDays = 0;
    if (subscription.endDate) {
      remainingDays = Math.ceil(
        (subscription.endDate.getTime() - now.getTime()) / (1000 * 3600 * 24),
      );
    }

    if (remainingDays !== subscription.remainingDays) {
      this.prisma.subscription
        .update({
          where: { id: subscription.id },
          data: { remainingDays: Math.max(0, remainingDays) },
        })
        .catch((err) => console.error('Failed to update remaining days', err));
    }

    return {
      success: true,
      plan: SubscriptionPlan.PRO,
      status: 'active',
      subscription: {
        ...subscription,
        remainingDays: Math.max(0, remainingDays),
      },
    };
  }

  async createProductAndPrice(dto: CreateProductAndPriceDto) {
    const { product, price } = await StripePayment.createProductAndPrice({
      name: dto.name,
      unit_amount: dto.price * 100, // Stripe requires cents
      currency: dto.currency,
      interval: dto.interval,
      interval_count: dto.interval_count,
    });

    const productRecord = await this.prisma.subsPlan.create({
      data: {
        stripeProductId: product.id,
        stripePriceId: price.id,
        name: dto.name,
        slug: dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        price: dto.price,
        currency: dto.currency,
        interval: dto.interval.toUpperCase() as any,
        intervalCount: dto.interval_count,
        description: dto.product_description,
        price_description: dto.price_description,
      },
    });

    return productRecord;
  }

  async addCard(user: any, addCardDto: AddCardDto) {
    try {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.userId },
      });

      if (!dbUser) {
        throw new BadRequestException('User not found');
      }

      // Check if user already has an active subscription
      const existingSubscription = await this.prisma.subscription.findFirst({
        where: {
          userId: dbUser.id,
        },
      });

      if (existingSubscription && existingSubscription.isActive) {
        throw new BadRequestException(
          'User already has an active subscription',
        );
      }

      let customerId = dbUser.billing_id;

      if (!customerId) {
        // Create Stripe Customer
        const customer = await StripePayment.createCustomer({
          email: dbUser.email,
          name: `${dbUser.first_name} ${dbUser.last_name}`,
          user_id: dbUser.id,
        });
        customerId = customer.id;

        // Update user with billing_id
        await this.prisma.user.update({
          where: { id: dbUser.id },
          data: { billing_id: customerId },
        });
      }

      const productRecord = await this.prisma.subsPlan.findFirst({
        where: { id: addCardDto.productId },
      });
      if (!productRecord) {
        throw new BadRequestException('Subscription plan not found for user');
      }
      const paymentMethod = await StripePayment.createPaymentMethod(
        addCardDto.token,
        dbUser.billing_id,
      );

      const subscription = await StripePayment.createSubscription({
        payment_method_id: paymentMethod.id,
        customer_id: dbUser.billing_id,
        price_id: productRecord.stripePriceId,
        // trial_period_days: productRecord.trialDays,
      });

      console.log('Stripe Subscription Created:', JSON.stringify(subscription));
      console.log(
        'current_period_end:',
        (subscription as any).current_period_end,
      );

      const existingSub = await this.prisma.subscription.findFirst({
        where: { userId: dbUser.id },
      });

      const startDateTimestamp =
        (subscription as any).current_period_start ||
        (subscription as any).start_date ||
        (subscription as any).created;

      const startDate = startDateTimestamp
        ? new Date(startDateTimestamp * 1000)
        : new Date();

      const endDateTimestamp =
        (subscription as any).current_period_end ||
        (subscription as any).items?.data?.[0]?.current_period_end ||
        (subscription as any).ended_at ||
        (subscription as any).trial_end;

      const endDate = endDateTimestamp
        ? new Date(endDateTimestamp * 1000)
        : new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000); // Default to 30 days if missing

      let updatedSubscription;
      const subData = {
        userId: dbUser.id,
        isActive: true,
        status: (subscription as any).status,
        plan: { connect: { id: productRecord.id } }, // Use connect for relation
        startDate: startDate,
        endDate: endDate,
        stripeSubId: subscription.id,
        planType: SubscriptionPlan.PRO, // Correct field name
        cancelAtPeriodEnd: (subscription as any).cancel_at_period_end || false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      if (existingSub) {
        const { plan, ...updateData } = subData;
        updatedSubscription = await this.prisma.subscription.update({
          where: { id: existingSub.id },
          data: {
            ...updateData,
            plan: plan, // Connect new plan
          },
        });

        // Update user's plan
        await this.prisma.user.update({
          where: { id: dbUser.id },
          data: { plan: 'PRO' },
        });
      } else {
        updatedSubscription = await this.prisma.subscription.create({
          data: subData,
        });

        // Update user's plan
        await this.prisma.user.update({
          where: { id: dbUser.id },
          data: { plan: 'PRO' },
        });
      }

      // Notify user about successful subscription
      await NotificationRepository.createNotification({
        receiver_id: dbUser.id,
        type: 'SUBSCRIPTION_SUCCESS',
        text: `You have successfully subscribed to ${productRecord.name}!`,
        entity_id: updatedSubscription.id,
      });

      return {
        success: true,
        message: 'Card added successfully',
        data: subscription,
      };
    } catch (error: any) {
      // Notify user about failure
      await NotificationRepository.createNotification({
        receiver_id: user.userId,
        type: 'SUBSCRIPTION_FAILED',
        text: 'Subscription failed. Please check your card details.',
      });

      if (error?.raw?.code === 'token_already_used') {
        throw new BadRequestException(
          'This payment token has already been used. Please retry the payment.',
        );
      }
      throw new BadRequestException('Failed to add card: ' + error.message);
    }
  }

  async getAllPlans() {
    const plans = await this.prisma.subsPlan.findMany({
      orderBy: { price: 'asc' },
    });
    return {
      success: true,
      plans: plans,
    };
  }

  async cancelSubscription(userId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: userId,
        isActive: true,
      },
    });

    if (!subscription) {
      throw new BadRequestException('No active subscription found');
    }

    try {
      const canceledSub = await StripePayment.cancelSubscription(
        subscription.stripeSubId,
      );

      // Update local DB
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          isActive: false,
          status: canceledSub.status,
          endDate: new Date(),
        },
      });

      // Update user's plan to FREE
      await this.prisma.user.update({
        where: { id: userId },
        data: { plan: 'FREE' },
      });

      // Notify user about cancellation
      await NotificationRepository.createNotification({
        receiver_id: userId,
        type: 'SUBSCRIPTION_CANCELED',
        text: 'Your subscription has been canceled.',
        entity_id: subscription.id,
      });

      return {
        success: true,
        message: 'Subscription canceled successfully',
      };
    } catch (error) {
      throw new BadRequestException(
        'Failed to cancel subscription: ' + error.message,
      );
    }
  }
}
