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
import { RefreshToken } from './entities/refresh-token.entity';
import { RefreshTokenService } from './refresh-token.service';

const jwtModule = JwtModule.register({
  secret: jwtConfig.secret,
  signOptions: { expiresIn: jwtConfig.accessExpiresIn }, //accessToken 有效期
});

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken]),
    PassportModule,
    jwtModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LocalStrategy,
    JwtStrategy,
    UserService,
    RefreshTokenService,
  ],
  exports: [jwtModule, AuthService, RefreshTokenService],
})
export class AuthModule {}
