import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { AccountCleanupModule } from '../account/account-cleanup.module';

@Module({
  // AuthModule 不反向依赖 UserModule（自带 UserService），无循环引用
  imports: [TypeOrmModule.forFeature([User]), AuthModule, AccountCleanupModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
