import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GenerateImageDto,
  AspectRatio,
  GenerationType,
} from './dto/generate-image.dto';
import { SazedStorage } from '../../common/lib/Disk/SazedStorage';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { StringHelper } from 'src/common/helper/string.helper';
import appConfig from 'src/config/app.config';
import { NotificationRepository } from '../../common/repository/notification/notification.repository';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private openai: OpenAI;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
      timeout: 60 * 1000, // 60 seconds timeout for OpenAI API
    });
  }

  private mapAspectToSize(aspect: AspectRatio) {
    switch (aspect) {
      case AspectRatio.SQUARE:
        return '1024x1024';
      case AspectRatio.PORTRAIT:
        return '1024x1792';
      case AspectRatio.LANDSCAPE:
        return '1792x1024';
      default:
        return '1024x1024';
    }
  }

  private buildPrompt(dto: GenerateImageDto, skipDefaults = false) {
    if (skipDefaults) {
      return dto.prompt;
    }

    const safeStyle = dto.style ? `Style: ${dto.style}.` : '';

    let styleInstructions =
      'High detail, cinematic lighting, high resolution, no watermarks, realistic textures.';
    if (dto.type === GenerationType.SKETCH) {
      styleInstructions =
        'High detail, pencil sketch style, rough lines, charcoal shading, black and white, no watermarks.';
    }

    const baseInstructions = [
      dto.prompt,
      safeStyle,
      styleInstructions,
      'No extra text overlays. Produce a single, high-quality scene suitable for mobile display.',
    ]
      .filter(Boolean)
      .join(' ');

    if (dto.styleImage) {
      return `${baseInstructions} Reference style image: ${dto.styleImage}`;
    }
    return baseInstructions;
  }

  private async moderatePrompt(prompt: string) {
    try {
      const resp = await this.openai.moderations.create({
        model: 'omni-moderation-latest',
        input: prompt,
      });

      const results = resp.results?.[0];
      if (!results) return true;

      if (results.flagged) {
        this.logger.warn('Prompt flagged by moderation', {
          prompt,
          categories: results.categories,
        });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error('Moderation check failed', err);
      return true;
    }
  }

  private async checkUserLimit(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    // Cast to any because Prisma Client hasn't been regenerated yet
    if ((user as any).plan !== 'PRO') {
      const count = await this.prisma.generation.count({
        where: { user_id: userId },
      });
      if (count >= 3) {
        return {
          allowed: false,
          message:
            'Free limit reached (3 images). Please upgrade to PRO to generate more.',
        };
      }
    }
    return { allowed: true };
  }

  /**
   * Main image generation function.
   * - Runs moderation
   * - Builds a better prompt
   * - Calls OpenAI images API (either DALL-E or gpt-image-1 depending on config)
   * - Downloads result (b64 or url)
   * - Uploads to storage (S3/local)
   * - Saves generation record to DB
   */
  async generateImage(
    userId: string,
    dto: GenerateImageDto,
    skipDefaults = false,
  ) {
    // 1. Check User Plan & Limits
    const limitCheck = await this.checkUserLimit(userId);
    if (!limitCheck.allowed) {
      return { success: false, message: limitCheck.message };
    }

    // Basic guard
    if (!this.configService.get('openai.apiKey')) {
      throw new UnauthorizedException('OpenAI API key not configured.');
    }

    // Moderation
    const allowed = await this.moderatePrompt(dto.prompt);
    if (!allowed)
      throw new BadRequestException('Prompt violates content policy.');

    const size = this.mapAspectToSize(dto.aspectRatio);
    const finalPrompt = this.buildPrompt(dto, skipDefaults);

    // Choose model (allow DALL·E if configured, otherwise use dall-e-3)
    const preferDalle =
      this.configService.get('OPENAI_PREFER_DALLE') === 'true';
    const imageModel = preferDalle
      ? this.configService.get('OPENAI_DALLE_MODEL') || 'dall-e-3'
      : 'dall-e-3';

    let generatedImageBuffer: Buffer;

    try {
      this.logger.log(
        `Generating image for user ${userId} with model ${imageModel}`,
      );

      const response = await this.openai.images.generate({
        model: imageModel,
        prompt: finalPrompt,
        size,
        n: 1,
        response_format: 'b64_json',
      } as any);

      // Newer SDKs may return either b64_json or a url. Handle both.
      const datum = response.data?.[0];
      if (!datum)
        throw new InternalServerErrorException(
          'No data returned from OpenAI image generation.',
        );

      // Case 1: b64_json
      if (datum.b64_json) {
        const buffer = Buffer.from(datum.b64_json, 'base64');
        generatedImageBuffer = buffer;
      } else if (datum.url) {
        // Case 2: direct URL  -> download
        const imgResp = await axios.get(datum.url, {
          responseType: 'arraybuffer',
        });
        generatedImageBuffer = Buffer.from(imgResp.data);
      } else {
        // Unknown format
        throw new InternalServerErrorException(
          'Unknown image response format.',
        );
      }

      // Persist to storage (S3)
      const fileName = `${StringHelper.randomString()}-${uuidv4()}.png`;
      const key = `${appConfig().storageUrl.photo}/${fileName}`;

      await SazedStorage.put(key, generatedImageBuffer);
      const publicUrl = SazedStorage.url(key);

      // Save DB record
      const saved = await this.prisma.generation.create({
        data: {
          user_id: userId,
          title: finalPrompt.substring(0, 100),
          prompt: dto.prompt,
          aspect_ratio: dto.aspectRatio,
          style: dto.style,
          style_image: dto.styleImage,
          image_url: publicUrl,
          type: dto.type,
          file_size: generatedImageBuffer.length,
        },
      });

      this.logger.log(`Image generated and saved for generation ${saved.id}`);

      // Create Notification using Repository (triggers Redis & WebSocket)
      await NotificationRepository.createNotification({
        receiver_id: userId,
        type: 'IMAGE_READY',
        text: 'Your latest creation is ready! Tap to view.',
        entity_id: saved.id,
      });

      return {
        success: true,
        data: { imageUrl: publicUrl, generationId: saved.id },
      };
    } catch (err) {
      this.logger.error('Image generation failed', err as any);

      // Notify user about failure
      await NotificationRepository.createNotification({
        receiver_id: userId,
        type: 'IMAGE_FAILED',
        text: 'Image generation failed. Please try again.',
      });

      const msg = (err as any)?.message || 'Image generation failed';
      throw new InternalServerErrorException(msg);
    }
  }

  async deleteGeneration(userId: string, generationId: string) {
    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
    });

    if (!generation) throw new NotFoundException('Generation not found');
    if (generation.user_id !== userId)
      throw new ForbiddenException('You can only delete your own generations');

    await this.prisma.generation.delete({ where: { id: generationId } });
    return { success: true, message: 'Generation deleted successfully' };
  }

  async downloadGeneration(userId: string, generationId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: userId,
        isActive: true,
        status: { in: ['active', 'trialing'] },
      },
    });

    if ((user as any).plan !== 'PRO' && !subscription) {
      return {
        success: false,
        message:
          'Premium Feature! Upgrade plan to unlock premium features and content!',
      };
    }

    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
    });

    if (!generation) throw new NotFoundException('Generation not found');
    if (generation.user_id !== userId)
      throw new ForbiddenException('Access denied');

    // send a push notification.
    await NotificationRepository.createNotification({
      receiver_id: userId,
      type: 'IMAGE_DOWNLOADED',
      text: 'Your image has been downloaded successfully!',
      entity_id: generation.id,
    });

    // Mark as downloaded
    await this.prisma.generation.update({
      where: { id: generationId },
      data: { is_downloaded: true },
    });

    return {
      success: true,
      message: 'Image downloaded successfully',
      data: { url: generation.image_url },
    };
  }

  async getDownloadById(userId: string, generationId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: userId,
        isActive: true,
        status: { in: ['active', 'trialing'] },
      },
    });

    if ((user as any).plan !== 'PRO' && !subscription) {
      return {
        success: false,
        message:
          'Premium Feature! Upgrade plan to unlock premium features and content!',
      };
    }

    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
    });
    if (!generation) throw new NotFoundException('Generation not found');
    if (generation.user_id !== userId)
      throw new ForbiddenException('Access denied');
    return {
      success: true,
      data: generation,
    };
  }

  /**
   * Chat (protected)
   * - Uses a safer modern chat model
   * - Optionally include system prompt for personality
   * - Persists chat history
   */
  async chat(userId: string, message: string, conversationId?: string) {
    // Check User Plan
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: userId,
        isActive: true,
        status: { in: ['active', 'trialing'] },
      },
    });

    if ((user as any).plan !== 'PRO' && !subscription) {
      return {
        success: false,
        message:
          'Premium Feature! Upgrade plan to unlock premium features and content!',
      };
    }

    if (!message || !message.trim())
      throw new BadRequestException('Message is empty.');

    // Basic moderation
    const allowed = await this.moderatePrompt(message);
    if (!allowed)
      throw new BadRequestException('Message violates content policy.');

    try {
      // 1. Find or create conversation
      let conversation;

      if (conversationId) {
        conversation = await this.prisma.aiConversation.findFirst({
          where: { id: conversationId, user_id: userId },
        });
      }

      // If no conversationId is provided, OR if the provided ID was not found,
      // we create a NEW conversation.
      if (!conversation) {
        conversation = await this.prisma.aiConversation.create({
          data: {
            user_id: userId,
            title: message.substring(0, 30) + '...',
          },
        });
      }

      // 2. Save User Message
      await this.prisma.aiMessage.create({
        data: {
          conversation_id: conversation.id,
          role: 'user',
          content: message,
        },
      });

      // 3. Get Chat History (Context)
      const history = await this.prisma.aiMessage.findMany({
        where: { conversation_id: conversation.id },
        orderBy: { created_at: 'desc' },
        take: 10,
      });

      const messages = history.reverse().map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      const model =
        this.configService.get('OPENAI_CHAT_MODEL') || 'gpt-3.5-turbo';
      const systemPrompt =
        this.configService.get<string>('CHAT_SYSTEM_PROMPT') ||
        'You are a friendly AI companion. Keep answers concise and safe.';

      const completion = await this.openai.chat.completions.create({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 800,
      });

      const reply = completion.choices?.[0]?.message?.content ?? '';

      // 4. Save Assistant Message
      if (reply) {
        await this.prisma.aiMessage.create({
          data: {
            conversation_id: conversation.id,
            role: 'assistant',
            content: reply,
          },
        });

        // Update conversation timestamp
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { updated_at: new Date() },
        });
      }

      return {
        success: true,
        data: { reply, conversationId: conversation.id },
      };
    } catch (err) {
      this.logger.error('Chat generation failed', err as any);
      throw new InternalServerErrorException('Chat generation failed.');
    }
  }

  async getConversations(userId: string) {
    const conversations = await this.prisma.aiConversation.findMany({
      where: { user_id: userId },
      orderBy: { updated_at: 'desc' },
      include: {
        messages: {
          take: 1,
          orderBy: { created_at: 'desc' },
        },
      },
    });

    return {
      success: true,
      data: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at,
        lastMessage: c.messages[0]?.content || '',
      })),
    };
  }

  async getConversationMessages(userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, user_id: userId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const messages = await this.prisma.aiMessage.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'asc' },
    });

    return {
      success: true,
      data: {
        conversation,
        messages,
      },
    };
  }

  async deleteConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, user_id: userId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    await this.prisma.aiConversation.delete({
      where: { id: conversationId },
    });

    return {
      success: true,
      message: 'Conversation deleted successfully',
    };
  }

  async generateFromImage(
    userId: string,
    dto: GenerateImageDto,
    image: Express.Multer.File,
  ) {
    if (!image) throw new BadRequestException('Image file is required');

    // 1. Check User Plan & Limits
    const limitCheck = await this.checkUserLimit(userId);
    if (!limitCheck.allowed) {
      return { success: false, message: limitCheck.message };
    }

    // 2. Analyze Image with GPT-4o Vision
    let mediaUrl: string | undefined;

    if (image?.buffer) {
      try {
        // 1. Upload new avatar
        const fileName = `${StringHelper.randomString()}-${image.originalname}`;
        const key = `${appConfig().storageUrl.avatar}/${fileName}`;

        await SazedStorage.put(key, image.buffer);
        mediaUrl = SazedStorage.url(key);
      } catch (err: any) {
        console.warn('image upload failed:', err.message || err);
        throw new InternalServerErrorException('Image upload failed');
      }
    }

    try {
      const visionResponse = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Describe this image in detail. Then, create a DALL-E 3 prompt based on this description but modified by the following user instruction: "${dto.prompt}". The output should be ONLY the prompt text, nothing else.`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: mediaUrl,
                },
              },
            ],
          },
        ],
        max_tokens: 300,
      });

      const newPrompt = visionResponse.choices[0].message.content;
      this.logger.log(`Generated prompt from image: ${newPrompt}`);

      // 3. Generate Image with new prompt
      const newDto = {
        ...dto,
        prompt: newPrompt,
        style: undefined,
        styleImage: undefined,
      };
      return await this.generateImage(userId, newDto, true);
    } catch (err) {
      this.logger.error('Vision analysis failed', err);

      // Notify user about failure
      await NotificationRepository.createNotification({
        receiver_id: userId,
        type: 'IMAGE_FAILED',
        text: 'Failed to analyze reference image.',
      });

      throw new InternalServerErrorException('Failed to analyze image');
    }
  }

  async getDownloadsByType(userId: string, type: string) {
    try {
      // Validate type
      if (!Object.values(GenerationType).includes(type as GenerationType)) {
        throw new BadRequestException('Invalid generation type');
      }

      const downloads = await this.prisma.generation.findMany({
        where: {
          user_id: userId,
          type: type as GenerationType,
          is_downloaded: true,
        },
        orderBy: {
          created_at: 'desc',
        },
      });
      return {
        success: true,
        data: downloads,
      };
    } catch (err) {
      this.logger.error('Failed to get downloads by type', err);
      throw new InternalServerErrorException('Failed to get downloads by type');
    }
  }
}
