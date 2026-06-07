import Redis from 'ioredis';
import type { Server as SocketIOServer } from 'socket.io';
import type { LogEntry } from './compilationService';

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

    // Set up Redis pub/sub for cross-process communication
    const redisHost = process.env.REDIS_HOST || (process.env.NODE_ENV === 'production' ? 'redis' : 'localhost');
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
    const redisPassword = process.env.REDIS_PASSWORD || undefined;
    const redisDb = parseInt(process.env.REDIS_DB || '0', 10);

    // Set up Redis publisher (always needed for workers and main server)
    if (!this.redisPublisher) {
      this.redisPublisher = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        db: redisDb
      });

      this.redisPublisher.on('error', (err: Error) => {
        console.error('[SocketService] Redis publisher error:', err);
      });

      console.log('[SocketService] Redis publisher initialized');
    }

    // Only set up subscriber in the main server (not in workers)
    if (ioInstance && !this.redisSubscriber) {
      this.redisSubscriber = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        db: redisDb
      });

      // Subscribe to job log channels
      this.redisSubscriber.psubscribe('job:log:*');
      this.redisSubscriber.psubscribe('job:status:*');

      // Handle messages from Redis and emit via Socket.IO
      this.redisSubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        try {
          const data = JSON.parse(message);
          const jobId = channel.split(':').pop();

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
