/** 指令路由集成测试（Fastify inject + 注入 mock router，不构造整树依赖） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';

import { commandRoutes } from './command.js';
import type { CommandRouter, CommandResult } from '../commands/command-router.js';

let app: FastifyInstance;

/**
 * 构造一个最小 app：仅注册 command 路由 + 复刻 app.ts 的 ZodError→400 处理，
 * 避免构造整树依赖（符合 FEAT-002 steps 的「优先独立注册」指引）。
 */
function buildMinimalApp(router: CommandRouter): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.register(commandRoutes, { router });
  instance.setErrorHandler(
    (error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: { message: error.issues.map((i) => i.message).join('; '), code: 'VALIDATION_ERROR' },
        });
      }
      return reply.code(500).send({ error: { message: '服务器内部错误' } });
    },
  );
  return instance;
}

afterEach(async () => {
  await app.close();
});

describe('POST /api/command', () => {
  it('immediate_action 结果原样下发（200）', async () => {
    const result: CommandResult = { intent: 'immediate_action', executed: true, entityId: 'light.living_room' };
    const router: CommandRouter = { route: vi.fn().mockResolvedValue(result) };
    app = buildMinimalApp(router);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/command', payload: { text: '关客厅灯' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it('item_record 结果原样下发（200）', async () => {
    const result: CommandResult = { intent: 'item_record', items: [] };
    const router: CommandRouter = { route: vi.fn().mockResolvedValue(result) };
    app = buildMinimalApp(router);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/command', payload: { text: '买了牛奶' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().intent).toBe('item_record');
  });

  it('query 结果原样下发（200）', async () => {
    const result: CommandResult = { intent: 'query', expiringItems: [] };
    const router: CommandRouter = { route: vi.fn().mockResolvedValue(result) };
    app = buildMinimalApp(router);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/command', payload: { text: '快过期的' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().intent).toBe('query');
  });

  it('unknown 结果原样下发（200）', async () => {
    const result: CommandResult = { intent: 'unknown', message: '未能识别该指令' };
    const router: CommandRouter = { route: vi.fn().mockResolvedValue(result) };
    app = buildMinimalApp(router);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/command', payload: { text: '哈喽' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe('未能识别该指令');
  });

  it('text 为空字符串 → 400 VALIDATION_ERROR', async () => {
    const router: CommandRouter = { route: vi.fn() };
    app = buildMinimalApp(router);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/command', payload: { text: '' } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(router.route).not.toHaveBeenCalled();
  });

  it('text 全空白 → 400 VALIDATION_ERROR', async () => {
    const router: CommandRouter = { route: vi.fn() };
    app = buildMinimalApp(router);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/command', payload: { text: '   ' } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('source 透传给 router.route', async () => {
    const result: CommandResult = { intent: 'item_record', items: [] };
    const route = vi.fn().mockResolvedValue(result);
    const router: CommandRouter = { route };
    app = buildMinimalApp(router);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/command', payload: { text: '买了牛奶', source: 'voice' } });

    expect(route).toHaveBeenCalledWith('买了牛奶', { source: 'voice' });
  });

  it('无 source 时以空 opts 调用 router.route', async () => {
    const result: CommandResult = { intent: 'unknown', message: 'x' };
    const route = vi.fn().mockResolvedValue(result);
    const router: CommandRouter = { route };
    app = buildMinimalApp(router);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/command', payload: { text: '测试' } });

    expect(route).toHaveBeenCalledWith('测试', {});
  });
});
