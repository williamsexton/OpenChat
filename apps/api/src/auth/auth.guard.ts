import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';
import { User } from '@prisma/client';

/**
 * P1-02 — Composite auth guard, a true superset of SessionGuard. A request is
 * authenticated by, in order:
 *   1. a native access JWT (Authorization: Bearer …, P1-01), or
 *   2. a legacy personal/app token `oc_…` (Bearer, or ?token= for <img>/<video>
 *      media that can't set headers) — DEPRECATED but still honored so installed
 *      desktop clients (< 0.8.3) and PATs keep working, or
 *   3. the browser session cookie (web).
 * `@CurrentUser` and the attached user shape are unchanged.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Bearer header, or ?token= for requests that can't set headers (media elements).
    const header: string | undefined = request.headers?.authorization;
    const raw = (typeof header === 'string' && header.startsWith('Bearer '))
      ? header.slice(7).trim()
      : (typeof request.query?.token === 'string' ? request.query.token.trim() : '');

    if (raw) {
      // 1) native access JWT
      const jwtUserId = await this.tokens.verifyAccess(raw);
      if (jwtUserId) {
        const user = await this.prisma.user.findUnique({ where: { id: jwtUserId } });
        if (!user) throw new UnauthorizedException('User not found');
        request.user = this.serializeUser(user);
        return true;
      }
      // 2) legacy app/personal token (oc_…) — DEPRECATED; kept for BC with SessionGuard
      const tokenHash = createHash('sha256').update(raw).digest('hex');
      const token = await this.prisma.apiToken.findUnique({ where: { tokenHash }, include: { user: true } });
      if (token && !token.revokedAt && !(token.expiresAt && token.expiresAt.getTime() < Date.now())) {
        if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 60_000) {
          this.prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        }
        request.user = this.serializeUser(token.user);
        return true;
      }
      // Neither a valid JWT nor a valid app token: fall through to the session cookie
      // (a browser tab with a stale header keeps working), else 401 below.
    }

    const sessionUserId: string | null = request.session?.userId ?? null;
    if (!sessionUserId) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: sessionUserId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    request.user = this.serializeUser(user);
    return true;
  }

  private serializeUser(user: User): Omit<User, 'authSub'> {
    const { authSub: _authSub, ...safeUser } = user;
    return safeUser as unknown as Omit<User, 'authSub'>;
  }
}
