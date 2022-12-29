import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy';
import { JwtModule } from '@nestjs/jwt';
import { jwtConfig } from 'src/core/config/config';
import { JwtStrategy } from './jwt.strategy';
import { UserService } from 'src/user/user.service';

const jwtModule = JwtModule.register({
  secret: jwtConfig.secret,
  signOptions: { expiresIn: '3d' }, //签名有效时间
});

@Module({
  imports: [TypeOrmModule.forFeature([User]), PassportModule, jwtModule],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy, UserService],
  exports: [jwtModule],
})
export class AuthModule {}
