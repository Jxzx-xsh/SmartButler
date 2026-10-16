/** 采集网关路由集成测试（Fastify inject + 注入 mock 网关持有者） */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { CaptureStatus } from '../capture/gateway.js';
import { createCaptureGatewayHolder, type CaptureGatewayHolder } from './capture.js';
import type {
  FrameBroadcaster,
  FrameListener,
} from '../capture/frame-broadcaster.js';

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

describe('GET /api/capture/stream', () => {
  /**
   * 构造一个记录型 mock 广播器：记录 addListener 的 cb、removeListener 调用，
   * 并维护真实的订阅数组（支持 publish 下发与 listenerCount 查询）。
   */
  function makeMockBroadcaster(): FrameBroadcaster & {
    listeners: FrameListener[];
  } {
    const listeners: FrameListener[] = [];
    return {
      listeners,
      publish(buffer: Buffer, timestamp: number): void {
        for (const cb of [...listeners]) {
          cb(buffer, timestamp);
        }
      },
      addListener: vi.fn((cb: FrameListener): (() => void) => {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i !== -1) listeners.splice(i, 1);
        };
      }),
      removeListener: vi.fn((cb: FrameListener): void => {
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      }),
      listenerCount: (): number => listeners.length,
    };
  }

  /** 一个最小完整 JPEG 帧（SOI..EOI）。 */
  const JPEG = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);

  /**
   * 启动真实监听（stream 是 hijack 持久响应，inject 不适用——它要等响应结束才
   * 结算，而本端点只在连接关闭时结束，会死锁）。随机端口起 app，返回 base URL。
   */
  async function listen(): Promise<string> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('无法获取监听地址');
    }
    return `http://127.0.0.1:${addr.port}`;
  }

  /**
   * 发起一次 stream 请求：收集已到达的响应体字节，提供 abort 以关闭连接。
   * resolveHead 在收到响应头后兑现，便于断言头并控制推帧时机。
   */
  function openStream(baseUrl: string): {
    headers: Promise<http.IncomingHttpHeaders>;
    statusCode: Promise<number>;
    getChunks: () => Buffer[];
    waitBytes: (min: number) => Promise<void>;
    abort: () => void;
    done: Promise<void>;
  } {
    const chunks: Buffer[] = [];
    let resolveHead!: (h: http.IncomingHttpHeaders) => void;
    let resolveStatus!: (s: number) => void;
    let resolveDone!: () => void;
    const headers = new Promise<http.IncomingHttpHeaders>((r) => {
      resolveHead = r;
    });
    const statusCode = new Promise<number>((r) => {
      resolveStatus = r;
    });
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    const req = http.get(`${baseUrl}/api/capture/stream`, (res) => {
      resolveStatus(res.statusCode ?? 0);
      resolveHead(res.headers);
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('close', () => resolveDone());
      res.on('end', () => resolveDone());
    });
    req.on('error', () => resolveDone());

    const totalBytes = (): number =>
      chunks.reduce((sum, c) => sum + c.length, 0);

    return {
      headers,
      statusCode,
      getChunks: () => chunks,
      async waitBytes(min: number): Promise<void> {
        await vi.waitFor(() => expect(totalBytes()).toBeGreaterThanOrEqual(min));
      },
      abort: () => req.destroy(),
      done,
    };
  }

  it('响应头含 multipart/x-mixed-replace; boundary=frame', async () => {
    const broadcaster = makeMockBroadcaster();
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway, frameBroadcaster: broadcaster });
    await app.ready();
    const baseUrl = await listen();

    const stream = openStream(baseUrl);
    const headers = await stream.headers;
    expect(headers['content-type']).toBe(
      'multipart/x-mixed-replace; boundary=frame',
    );

    stream.abort();
    await stream.done;
  });

  it('推一帧后 payload 含 --frame 边界、image/jpeg、Content-Length 与帧字节', async () => {
    const broadcaster = makeMockBroadcaster();
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway, frameBroadcaster: broadcaster });
    await app.ready();
    const baseUrl = await listen();

    const stream = openStream(baseUrl);
    await stream.headers;
    // 等订阅建立后推一帧
    await vi.waitFor(() => expect(broadcaster.listeners.length).toBe(1));
    broadcaster.publish(JPEG, 1);
    await stream.waitBytes(JPEG.length + 10);

    const payload = Buffer.concat(stream.getChunks());
    expect(payload.includes(Buffer.from('--frame'))).toBe(true);
    expect(payload.includes(Buffer.from('Content-Type: image/jpeg'))).toBe(true);
    expect(
      payload.includes(Buffer.from(`Content-Length: ${JPEG.length}`)),
    ).toBe(true);
    expect(payload.includes(JPEG)).toBe(true);

    stream.abort();
    await stream.done;
  });

  it('getLatestFrame 非 null 时首帧立即下发', async () => {
    const latest = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const broadcaster = makeMockBroadcaster();
    const gateway = makeMockGateway({
      getLatestFrame: vi.fn().mockReturnValue(latest),
    });
    app = buildApp({ db, captureGateway: gateway, frameBroadcaster: broadcaster });
    await app.ready();
    const baseUrl = await listen();

    // 不推新帧：首帧应在订阅前立即写出
    const stream = openStream(baseUrl);
    await stream.headers;
    await stream.waitBytes(latest.length + 10);

    const payload = Buffer.concat(stream.getChunks());
    expect(payload.includes(latest)).toBe(true);
    expect(payload.includes(Buffer.from('--frame'))).toBe(true);

    stream.abort();
    await stream.done;
  });

  it('连接关闭后订阅被清理、listenerCount 归零', async () => {
    const broadcaster = makeMockBroadcaster();
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway, frameBroadcaster: broadcaster });
    await app.ready();
    const baseUrl = await listen();

    const stream = openStream(baseUrl);
    await stream.headers;
    await vi.waitFor(() => expect(broadcaster.listeners.length).toBe(1));

    // 客户端断开 → 服务端 request 'close' → cleanup 退订
    stream.abort();
    await stream.done;
    // cleanup 走 addListener 返回的退订函数 off()，listenerCount 归零即证明无泄漏
    await vi.waitFor(() => expect(broadcaster.listenerCount()).toBe(0));
  });

  it('未注入广播器且无最新帧时返回 503 NO_STREAM', async () => {
    const gateway = makeMockGateway({
      getLatestFrame: vi.fn().mockReturnValue(null),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/stream' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('NO_STREAM');
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
