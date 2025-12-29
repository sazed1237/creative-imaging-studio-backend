import {
  Body,
  Controller,
  Post,
  UseGuards,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  Get,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GenerateImageDto } from './dto/generate-image.dto';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('AI')
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @ApiOperation({ summary: 'Generate an image based on a prompt' })
  @Post('generate-image')
  @UseGuards(JwtAuthGuard)
  async generateImage(
    @GetUser('userId') userId: string,
    @Body() dto: GenerateImageDto,
  ) {
    return await this.aiService.generateImage(userId, dto);
  }

  @Post('generate-from-image')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async generateFromImage(
    @GetUser('userId') userId: string,
    @Body() dto: GenerateImageDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return await this.aiService.generateFromImage(userId, dto, image);
  }

  @ApiOperation({ summary: 'Chat with the AI' })
  @Post('chat')
  @UseGuards(JwtAuthGuard)
  async chat(
    @GetUser('userId') userId: string,
    @Body('message') message: string,
    @Body('conversationId') conversationId?: string,
  ) {
    return await this.aiService.chat(userId, message, conversationId);
  }

  @ApiOperation({ summary: 'Get all conversations' })
  @Get('conversations')
  @UseGuards(JwtAuthGuard)
  async getConversations(@GetUser('userId') userId: string) {
    return await this.aiService.getConversations(userId);
  }

  @ApiOperation({ summary: 'Get messages of a conversation' })
  @Get('conversations/:id')
  @UseGuards(JwtAuthGuard)
  async getConversationMessages(
    @GetUser('userId') userId: string,
    @Param('id') id: string,
  ) {
    return await this.aiService.getConversationMessages(userId, id);
  }

  @ApiOperation({ summary: 'Delete a conversation' })
  @Delete('conversations/:id')
  @UseGuards(JwtAuthGuard)
  async deleteConversation(
    @GetUser('userId') userId: string,
    @Param('id') id: string,
  ) {
    return await this.aiService.deleteConversation(userId, id);
  }

  @ApiOperation({ summary: 'Download a generated image' })
  @Post('generation/:id/download')
  @UseGuards(JwtAuthGuard)
  async downloadGeneration(
    @GetUser('userId') userId: string,
    @Param('id') id: string,
  ) {
    return await this.aiService.downloadGeneration(userId, id);
  }

  @ApiOperation({ summary: 'Get downloaded images by id' })
  @Get('download/:id')
  @UseGuards(JwtAuthGuard)
  async getDownloadById(
    @GetUser('userId') userId: string,
    @Param('id') id: string,
  ) {
    return await this.aiService.getDownloadById(userId, id);
  }

  @ApiOperation({ summary: 'Get downloaded images by type' })
  @Get('downloads/:type')
  @UseGuards(JwtAuthGuard)
  async getDownloadsByType(
    @GetUser('userId') userId: string,
    @Param('type') type: string,
  ) {
    return await this.aiService.getDownloadsByType(userId, type);
  }

  @ApiOperation({ summary: 'Delete a generated image' })
  @Delete('generation/:id')
  @UseGuards(JwtAuthGuard)
  async deleteGeneration(
    @GetUser('userId') userId: string,
    @Param('id') id: string,
  ) {
    return await this.aiService.deleteGeneration(userId, id);
  }
}
