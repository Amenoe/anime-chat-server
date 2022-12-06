import { PartialType } from '@nestjs/mapped-types';
import { CreateAnimeEpDto } from './create-anime-ep.dto';

export class UpdateAnimeEpDto extends PartialType(CreateAnimeEpDto) {}
