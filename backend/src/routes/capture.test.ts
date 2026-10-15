/** 采集网关路由集成测试（Fastify inject + 注入 mock 网关持有者） */

import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { CaptureStatus } from '../capture/gateway.js';
import { createCaptureGatewayHolder, type CaptureGatewayHolder } from './capture.js';

let app: FastifyInstance;
let db: AppDatabase;

/** 一个基础状态模板（已配置源，connected，带若干指标）。 */
function makeStatus(overrides: Partial<CaptureStatus> = {}): CaptureStatus {
  return {
    state: 'connected',
    sourceUrl: 'http://192.168.1.10:8080/video',
    fps: 2,
    lastFrameAt: null,
    frameCount: 0,
    audioBytes: 0,
    reconnectAttempts: 0,
    ...overrides,
  };
}

/**
 * 构造仅实现所需方法的 mock 网关持有者。
 * getStatus 默认返回传入的 status（可被单测覆盖以模拟不同场景）。
 */
function makeMockGateway(
  overrides: Partial<CaptureGatewayHolder> = {},
): CaptureGatewayHolder {
  return {
    setSource: vi.fn(),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue(makeStatus()),
    getLatestFrame: vi.fn().mockReturnValue(null),
    ...overrides,
  } as CaptureGatewayHolder;
}

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/capture/status', () => {
  it('已配置源时返回 200 且 configured 为 true', async () => {
    const gateway = makeMockGateway({
      getStatus: vi.fn().mockReturnValue(makeStatus({ frameCount: 5 })),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.state).toBe('connected');
    expect(body.frameCount).toBe(5);
  });

  it('未配置源时返回 200 且 configured 为 false', async () => {
    const gateway = makeMockGateway({
      getStatus: vi
        .fn()
        .mockReturnValue(makeStatus({ state: 'stopped', sourceUrl: '' })),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.state).toBe('stopped');
  });
});

describe('POST /api/capture/start', () => {
  it('合法 URL 返回 200 并调用 setSource + start', async () => {
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/capture/start',
      payload: { url: 'http://192.168.1.10:8080/video', fps: 3 },
    });

    expect(res.statusCode).toBe(200);
    expect(gateway.setSource).toHaveBeenCalledWith(
      'http://192.168.1.10:8080/video',
      3,
    );
    expect(gateway.start).toHaveBeenCalledTimes(1);
    // 返回体为 getStatus() 结果
    expect(res.json().state).toBe('connected');
  });

  it('非法 URL 返回 400 VALIDATION_ERROR 且不调用 start', async () => {
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/capture/start',
      payload: { url: 'not-a-url' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(gateway.start).not.toHaveBeenCalled();
  });
});

describe('POST /api/capture/stop', () => {
  it('调用 stop 并返回 200 和最新状态', async () => {
    const gateway = makeMockGateway({
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(makeStatus({ state: 'stopped' })),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/capture/stop' });
    expect(res.statusCode).toBe(200);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(res.json().state).toBe('stopped');
  });
});

describe('GET /api/capture/snapshot', () => {
  it('有帧时返回 image/jpeg 二进制', async () => {
    // 构造一个最小 JPEG 字节（SOI...EOI），仅用于断言透传
    const frame = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]);
    const gateway = makeMockGateway({
      getLatestFrame: vi.fn().mockReturnValue(frame),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/snapshot' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.rawPayload.equals(frame)).toBe(true);
  });

  it('无帧时返回 503 NO_FRAME', async () => {
    const gateway = makeMockGateway({
      getLatestFrame: vi.fn().mockReturnValue(null),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/snapshot' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('NO_FRAME');
  });
});

describe('createCaptureGatewayHolder 回调透传', () => {
  /** 伪造 ffmpeg 子进程：stdout 为 EventEmitter，可手动投喂数据/触发关闭。 */
  /** stdout/stderr 用的最小可读流替身：EventEmitter + no-op resume()。 */
  class FakeStream extends EventEmitter {
    resume(): this {
      return this;
    }
  }
  class FakeChild extends EventEmitter {
    stdout = new FakeStream();
    stderr = new FakeStream();
    killed = false;
    exitCode: number | null = null;
    kill(): boolean {
      this.killed = true;
      return true;
    }
  }

  /**
   * 构造一个注入的 spawnFn：记录每次 spawn 出的子进程，并按视频/音频 args 区分。
   * 视频进程 args 含 'image2pipe'；音频进程 args 含 '-vn'。
   */
  function makeFakeSpawn(): { spawnFn: typeof spawn; videoProcs: FakeChild[]; audioProcs: FakeChild[] } {
    const videoProcs: FakeChild[] = [];
    const audioProcs: FakeChild[] = [];
    const spawnFn = ((_cmd: string, args: readonly string[]): FakeChild => {
      const child = new FakeChild();
      if (args.includes('image2pipe')) {
        videoProcs.push(child);
      } else {
        audioProcs.push(child);
      }
      return child;
    }) as unknown as typeof spawn;
    return { spawnFn, videoProcs, audioProcs };
  }

  /** 一个最小完整 JPEG 帧（SOI..EOI），供视频 stdout 投喂。 */
  const JPEG_FRAME = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

  it('初次构造后底层网关仍调用 baseOptions.onFrame/onAudio', () => {
    const { spawnFn, videoProcs, audioProcs } = makeFakeSpawn();
    const onFrame = vi.fn();
    const onAudio = vi.fn();
    const holder = createCaptureGatewayHolder({
      sourceUrl: 'http://cam/initial',
      fps: 2,
      spawnFn,
      onFrame,
      onAudio,
    });

    holder.start();
    // 投喂一帧视频与一段音频
    videoProcs[0]?.stdout.emit('data', JPEG_FRAME);
    audioProcs[0]?.stdout.emit('data', Buffer.from([0x00, 0x01, 0x02, 0x03]));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect((onFrame.mock.calls[0]?.[0] as Buffer).equals(JPEG_FRAME)).toBe(true);
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0]?.[0]).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });

  it('setSource 重建底层网关后 onFrame/onAudio 仍透传生效', () => {
    const { spawnFn, videoProcs, audioProcs } = makeFakeSpawn();
    const onFrame = vi.fn();
    const onAudio = vi.fn();
    const holder = createCaptureGatewayHolder({
      sourceUrl: 'http://cam/initial',
      fps: 2,
      spawnFn,
      onFrame,
      onAudio,
    });

    holder.start();
    // 切换到新源：触发底层网关重建
    holder.setSource('http://cam/new', 3);
    holder.start();

    // 重建后应产生第二组子进程
    expect(videoProcs.length).toBe(2);
    expect(audioProcs.length).toBe(2);

    // 向重建后的子进程投喂，验证回调仍被调用（透传未因重建丢失）
    videoProcs[1]?.stdout.emit('data', JPEG_FRAME);
    audioProcs[1]?.stdout.emit('data', Buffer.from([0x0a, 0x0b]));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect((onFrame.mock.calls[0]?.[0] as Buffer).equals(JPEG_FRAME)).toBe(true);
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0]?.[0]).toEqual(Buffer.from([0x0a, 0x0b]));
  });
});
