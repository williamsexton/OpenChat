import {
  Controller, Get, Post, Patch, Put, Delete, Param, Query, Body, Req, Res, UseGuards, NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { AuthGuard } from './auth.guard';
import { SessionGuard } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { User } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * P1-01 — Bearer token issuance (FR-AUTH-001/002).
   * Grants: authorization_code (native PKCE code posted by the app; server
   * finishes the exchange) and refresh_token (rotation; reuse kills the family).
   */
  @Post('oauth/token')
  async token(
    @Body()
    body: {
      grantType?: string;
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
      refreshToken?: string;
    },
  ) {
    if (body?.grantType === 'authorization_code') {
      if (!body.code || !body.codeVerifier || !body.redirectUri) {
        throw new BadRequestException('code, codeVerifier and redirectUri are required');
      }
      // P1-01 opt-in: try desktop PKCE code first (RFC 7636).
      // Desktop PKCE codes are server-minted (not from the IdP) and stored in Redis.
      // If the code isn't a desktop PKCE code, fall through to the OIDC exchange.
      const desktopUser = await this.authService.exchangeDesktopPkceCode(
        body.code,
        body.codeVerifier,
      );
      if (desktopUser) {
        const tokens = await this.tokenService.issueFamily(desktopUser.id);
        const user = await this.authService.getCurrentUser(desktopUser.id);
        return { ...tokens, user };
      }
      const user = await this.authService.exchangeNativeCode(
        body.code,
        body.codeVerifier,
        body.redirectUri,
      );
      const tokens = await this.tokenService.issueFamily(user.id);
      const { authSub: _authSub, ...safe } = user;
      return { ...tokens, user: safe };
    }
    if (body?.grantType === 'refresh_token') {
      if (!body.refreshToken) throw new BadRequestException('refreshToken is required');
      const { userId, ...tokens } = await this.tokenService.refresh(body.refreshToken);
      const user = await this.authService.getCurrentUser(userId);
      return { ...tokens, user };
    }
    throw new BadRequestException('grantType must be authorization_code or refresh_token');
  }

  /** P1-03 — public OIDC metadata for native clients (DR-002 option D). No auth, no secrets. */
  @Get('oidc-metadata')
  oidcMetadata() {
    return this.authService.oidcMetadata();
  }

  @Get('login')
  async login(@Req() req: Request, @Res() res: Response, @Query('returnTo') returnTo?: string) {
    // Only allow internal paths as returnTo (no open redirect).
    const safe = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : null;
    (req.session as typeof req.session & { returnTo?: string | null }).returnTo = safe;
    const url = await this.authService.beginLogin(req.session);
    res.redirect(url);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const session = req.session as typeof req.session & {
      userId?: string;
      idToken?: string;
      loginRetries?: number;
      returnTo?: string | null;
    };
    try {
      const { userId, idToken } = await this.authService.completeLogin(
        req.session,
        req.query as Record<string, string>,
      );
      session.userId = userId;
      session.idToken = idToken;
      session.loginRetries = 0;
      const dest = session.returnTo && session.returnTo.startsWith('/') && !session.returnTo.startsWith('//') ? session.returnTo : '/';
      session.returnTo = null;
      // Persist the logged-in session BEFORE redirecting so the app's first /auth/me finds it.
      await new Promise<void>((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
      res.redirect(dest);
    } catch (_err) {
      // A stale/overlapping login (e.g. OIDC state mismatch from multiple open flows) should
      // restart the login cleanly rather than 500 — Authentik's SSO session makes it instant.
      session.loginRetries = (session.loginRetries ?? 0) + 1;
      const tooMany = session.loginRetries > 2;
      if (tooMany) session.loginRetries = 0;
      await new Promise<void>((resolve) => req.session.save(() => resolve()));
      if (tooMany) {
        res
          .status(400)
          .send('Sign-in could not be completed. Please close other login tabs, clear this site’s cookies, and try again.');
      } else {
        res.redirect('/api/auth/login');
      }
    }
  }

  // Desktop sign-in handoff: after SSO, deliver a credential to the desktop client
  // via the openchat:// deep link. Unauthenticated → go log in first.
  //
  // DEFAULT (no query params): mint a bearer token and deep-link it (backward compat).
  //
  // OPT-IN PKCE (RFC 7636): when the client sends ?code_challenge=<S256>&code_challenge_method=S256,
  // mint a single-use authorization code instead of a token. The code is useless
  // without the code_verifier only the legitimate client holds.
  @Get('desktop')
  async desktopLogin(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code_challenge') codeChallenge?: string,
    @Query('code_challenge_method') codeChallengeMethod?: string,
  ) {
    const session = req.session as typeof req.session & { userId?: string };
    if (!session?.userId) {
      const qs = codeChallenge
        ? `?code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=${encodeURIComponent(codeChallengeMethod ?? '')}`
        : '';
      return res.redirect(`/api/auth/login?returnTo=/api/auth/desktop${qs}`);
    }

    // Opt-in PKCE: the client explicitly requests a code instead of a token.
    if (codeChallenge && codeChallengeMethod === 'S256') {
      const code = await this.authService.generateDesktopPkceCode(session.userId, codeChallenge);
      const deepLink = `openchat://auth?code=${encodeURIComponent(code)}`;
      res.type('html').send(
        `<!doctype html><meta charset="utf-8"><title>OpenChat</title>` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font-family:system-ui;background:#2f3136;color:#dcddde;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center">` +
        `<div><h2 style="color:#fff">Signing you in…</h2>` +
        `<p>OpenChat should open automatically. If it doesn't, <a style="color:#5865F2" href="${deepLink}">click here</a>.</p>` +
        `<p style="color:#8e9297;font-size:13px">You can close this tab.</p></div>` +
        `<script>location.href=${JSON.stringify(deepLink)}</script></body>`,
      );
      return;
    }

    // DEPRECATED legacy path (kept only for desktop clients < 0.8.3 that don't send a
    // code_challenge): mint a long-lived opaque app token and deep-link it. New clients
    // use the PKCE branch above → /auth/oauth/token (rotating refresh family). Remove once
    // old installs have updated.
    const { token } = await this.authService.createToken(session.userId, 'Desktop app');
    const deepLink = `openchat://auth?token=${encodeURIComponent(token)}`;
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>OpenChat</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:system-ui;background:#2f3136;color:#dcddde;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center">` +
      `<div><h2 style="color:#fff">Signing you in…</h2>` +
      `<p>OpenChat should open automatically. If it doesn't, <a style="color:#5865F2" href="${deepLink}">click here</a>.</p>` +
      `<p style="color:#8e9297;font-size:13px">You can close this tab.</p></div>` +
      `<script>location.href=${JSON.stringify(deepLink)}</script></body>`,
    );
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response, @Body() body?: { refreshToken?: string }) {
    // P1-02: a bearer client sends its refreshToken; revoke the whole family
    // (FR-AUTH-004) — then fall through to the session teardown, which is a
    // no-op for cookie-less requests and keeps the web path byte-identical.
    if (body?.refreshToken) {
      await this.tokenService.revokeFamilyOf(body.refreshToken);
    }
    const session = req.session as typeof req.session & { idToken?: string };
    if (!session?.idToken && body?.refreshToken) {
      req.session?.destroy(() => res.json({}));
      return;
    }
    let endSessionUrl = '/';
    try {
      endSessionUrl = await this.authService.endSessionUrl(session.idToken ?? '');
    } catch {
      /* IdP unreachable — still destroy the local session */
    }
    req.session.destroy(() => res.json({ endSessionUrl }));
  }

  // DEV ONLY: log in as a test user without Authentik. Gated by env; 404 in prod.
  @Post('dev-login')
  async devLogin(@Req() req: Request, @Body('username') username: string) {
    if (process.env.NODE_ENV === 'production' || process.env.DEV_AUTH !== '1') {
      throw new NotFoundException();
    }
    const user = await this.authService.devLogin(username || 'dev');
    (req.session as typeof req.session & { userId?: string }).userId = user.id;
    // P1-02: also hand out bearer tokens — the mobile test path (still 404 in prod).
    const tokens = await this.tokenService.issueFamily(user.id);
    return { ...user, ...tokens };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: Omit<User, 'authSub'>) {
    // getCurrentUser also lazily backfills the friend code for pre-existing users.
    return this.authService.getCurrentUser(user.id);
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  updateMe(
    @CurrentUser() user: Omit<User, 'authSub'>,
    @Body() body: { username?: string; displayName?: string; avatarUrl?: string; status?: string },
  ) {
    return this.authService.updateProfile(user.id, {
      username: typeof body.username === 'string' ? body.username.slice(0, 32) : undefined,
      displayName: typeof body.displayName === 'string' ? body.displayName.slice(0, 80) : undefined,
      avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl.slice(0, 1000) : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
    });
  }

  @Put('server-layout')
  @UseGuards(AuthGuard)
  updateServerLayout(@CurrentUser() user: Omit<User, 'authSub'>, @Body() body: { layout: unknown }) {
    return this.authService.updateServerLayout(user.id, body?.layout);
  }

  @Get('ws-ticket')
  @UseGuards(AuthGuard)
  wsTicket(@CurrentUser() user: Omit<User, 'authSub'>) {
    return this.authService.mintWsTicket(user.id);
  }

  // ---- personal access tokens (PATs) ----
  // These long-lived opaque tokens remain a supported power-user feature (scripts, bots,
  // API access). They are NO LONGER the desktop/native sign-in mechanism — native clients
  // use OAuth Authorization-Code + PKCE via POST /auth/oauth/token (see TokenService).

  @Get('tokens')
  @UseGuards(SessionGuard)
  listTokens(@CurrentUser() user: Omit<User, 'authSub'>) {
    return this.authService.listTokens(user.id);
  }

  @Post('tokens')
  @UseGuards(SessionGuard)
  createToken(
    @CurrentUser() user: Omit<User, 'authSub'>,
    @Body(new ZodValidationPipe(z.object({ name: z.string().trim().min(1).max(60).default('App token') }))) body: { name: string },
  ) {
    return this.authService.createToken(user.id, body.name);
  }

  @Delete('tokens/:id')
  @UseGuards(SessionGuard)
  revokeToken(@CurrentUser() user: Omit<User, 'authSub'>, @Param('id') id: string) {
    return this.authService.revokeToken(user.id, id);
  }
}
