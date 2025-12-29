import { IsNotEmpty, IsString, IsOptional, IsEnum } from 'class-validator';

export enum AspectRatio {
  SQUARE = '1:1',
  LANDSCAPE = '16:9',
  PORTRAIT = '9:16',
}

export enum GenerationType {
  ART = 'ART',
  SKETCH = 'SKETCH',
}

export enum styleEnum {
  REALISTIC_PORTRAITS = 'Realistic Portraits',
  OIL_PAINTING = 'Oil Painting',
  ABSTRACT = 'Abstract',
  DIGITAL_ART = 'Digital Art',
}

export class GenerateImageDto {
  @IsNotEmpty()
  @IsString()
  prompt: string;

  @IsNotEmpty()
  @IsEnum(AspectRatio)
  aspectRatio: AspectRatio;

  @IsOptional()
  @IsEnum(styleEnum)
  style?: styleEnum;

  @IsOptional()
  @IsString()
  styleImage?: string;

  @IsNotEmpty()
  @IsEnum(GenerationType)
  type: GenerationType;
}
