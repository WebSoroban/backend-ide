import Redis from 'ioredis';
import type { Server as SocketIOServer } from 'socket.io';
import type { LogEntry } from './compilationService';
import { createRedisClient, redisTarget } from '../lib/redis';

/**
 * Socket.IO service for emitting real-time log updates
 */
class SocketService {
  io: SocketIOServer | null;
  redisSubscriber: Redis | null;
  redisPublisher: Redis | null;

  constructor() {
    this.io = null;
    this.redisSubscriber = null;
    this.redisPublisher = null;
  }

  /**
   * Initialize Socket.IO instance and Redis pub/sub
   */
  init(ioInstance: SocketIOServer | null) {
    this.io = ioInstance;

    // Redis pub/sub for cross-process communication. Uses the same shared
    // connection config as BullMQ (REDIS_URL on managed hosts; host/port locally)
    // so the workers and the API always talk to the SAME Redis.

    // Set up Redis publisher (always needed for workers and main server)
    if (!this.redisPublisher) {
      this.redisPublisher = createRedisClient();

      this.redisPublisher.on('error', (err: Error) => {
        console.error('[SocketService] Redis publisher error:', err);
      });

      console.log(`[SocketService] Redis publisher initialized -> ${redisTarget()}`);
    }

    // Only set up subscriber in the main server (not in workers)
    if (ioInstance && !this.redisSubscriber) {
      this.redisSubscriber = createRedisClient();

      // Subscribe to job log channels
      this.redisSubscriber.psubscribe('job:log:*');
      this.redisSubscriber.psubscribe('job:status:*');
      // AI Copilot run streaming (tokens / reasoning / tool steps / status).
      this.redisSubscriber.psubscribe('ai:run:*');

      // Handle messages from Redis and emit via Socket.IO
      this.redisSubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        try {
          const data = JSON.parse(message);
          const jobId = channel.split(':').pop();

          if (pattern === 'ai:run:*') {
            // data = { runId, type, payload }
            this.io!.to(`run:${data.runId}`).emit('ai:event', data);
            return;
          }

          console.log(`[SocketService] Received Redis message for job ${jobId}, pattern: ${pattern}`);

          if (pattern === 'job:log:*') {
            // Emit log to Socket.IO room
            this.io!.to(`job:${jobId}`).emit('job:log', {
              jobId,
              log: data.log
            });
            console.log(`[SocketService] Emitted log to Socket.IO room job:${jobId}`);
          } else if (pattern === 'job:status:*') {
            // Emit status to Socket.IO room
            this.io!.to(`job:${jobId}`).emit('job:status', {
              jobId,
              status: data.status,
              result: data.result
            });
            console.log(`[SocketService] Emitted status to Socket.IO room job:${jobId}`);
          }
        } catch (error) {
          console.error('[SocketService] Error processing Redis message:', error);
        }
      });

      this.redisSubscriber.on('error', (err: Error) => {
        console.error('[SocketService] Redis subscriber error:', err);
      });

      console.log('[SocketService] Redis pub/sub subscriber initialized');
    }
  }

  /**
   * Emit log update for a specific job
   */
  emitLog(jobId: string, logEntry: LogEntry) {
    // Try direct Socket.IO first (if in same process)
    if (this.io) {
      this.io.to(`job:${jobId}`).emit('job:log', {
        jobId,
        log: logEntry
      });
    } else if (global.io) {
      global.io.to(`job:${jobId}`).emit('job:log', {
        jobId,
        log: logEntry
      });
    }

    // Also publish to Redis for cross-process communication
    if (this.redisPublisher) {
      const channel = `job:log:${jobId}`;
      const message = JSON.stringify({
        jobId,
        log: logEntry
      });
      console.log(`[SocketService] Publishing to Redis channel ${channel}:`, logEntry.message);
      this.redisPublisher.publish(channel, message).catch((err: any) => {
        console.error('[SocketService] Error publishing to Redis:', err);
      });
    } else {
      console.warn('[SocketService] Redis publisher not initialized, cannot emit log');
    }
  }

  /**
   * Emit multiple logs for a job
   */
  emitLogs(jobId: string, logs: LogEntry[]) {
    if (!this.io) {
      this.io = global.io;
    }

    if (this.io) {
      this.io.to(`job:${jobId}`).emit('job:logs', {
        jobId,
        logs: Array.isArray(logs) ? logs : []
      });
    }
  }

  /**
   * Emit an AI Copilot run event (token / reasoning / tool step / status) to the
   * `run:<runId>` Socket.IO room. Works from the agent worker too: it publishes
   * to Redis (`ai:run:<runId>`) so the API process relays it to subscribers.
   *
   *   type: 'token' | 'reasoning' | 'tool' | 'status' | 'error' | 'message'
   */
  emitRunEvent(runId: string, type: string, payload: any = {}) {
    const data = { runId, type, payload };
    const io = this.io || global.io;
    if (io) io.to(`run:${runId}`).emit('ai:event', data);
    if (this.redisPublisher) {
      this.redisPublisher.publish(`ai:run:${runId}`, JSON.stringify(data)).catch((err: any) => {
        console.error('[SocketService] Error publishing ai run event to Redis:', err);
      });
    }
  }

  /**
   * Emit job status update
   */
  emitJobStatus(jobId: string, status: string, result: any = null) {
    // Try direct Socket.IO first (if in same process)
    if (this.io) {
      this.io.to(`job:${jobId}`).emit('job:status', {
        jobId,
        status,
        result
      });
    } else if (global.io) {
      global.io.to(`job:${jobId}`).emit('job:status', {
        jobId,
        status,
        result
      });
    }

    // Also publish to Redis for cross-process communication
    if (this.redisPublisher) {
      this.redisPublisher
        .publish(
          `job:status:${jobId}`,
          JSON.stringify({
            jobId,
            status,
            result
          })
        )
        .catch((err: any) => {
          console.error('[SocketService] Error publishing status to Redis:', err);
        });
    }
  }
}

export default new SocketService();
