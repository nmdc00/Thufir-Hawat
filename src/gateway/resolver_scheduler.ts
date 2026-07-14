import type { ThufirConfig } from '../core/config.js';
import { resolveResolverNotificationConfig } from '../core/config.js';
import type { ScheduleDefinition } from '../core/scheduler_control_plane.js';

interface SchedulerLike {
  registerJob(
    definition: {
      name: string;
      schedule: ScheduleDefinition;
      leaseMs?: number;
    },
    handler: () => Promise<void>
  ): void;
}

interface LoggerLike {
  info(message: string): void;
}

interface ForecastBatch {
  checked: number;
  resolved: number;
}

export function registerResolverSchedulerJob(params: {
  config: Pick<ThufirConfig, 'notifications'>;
  scheduler: SchedulerLike;
  schedulerNamespace: string;
  logger: LoggerLike;
  runPredictionResolver: () => Promise<number>;
  runForecastResolver: () => Promise<ForecastBatch>;
}): boolean {
  const {
    config,
    scheduler,
    schedulerNamespace,
    logger,
    runPredictionResolver,
    runForecastResolver,
  } = params;
  const resolverConfig = resolveResolverNotificationConfig(config);
  if (!resolverConfig.enabled) return false;

  const resolverIntervalMs = Math.max(60_000, resolverConfig.intervalSeconds * 1000);
  scheduler.registerJob(
    {
      name: `gateway:${schedulerNamespace}:resolver`,
      schedule: { kind: 'interval', intervalMs: resolverIntervalMs },
      leaseMs: 60_000,
    },
    async () => {
      const updated = await runPredictionResolver();
      if (updated > 0) {
        logger.info(`Resolver: resolved ${updated} prediction(s).`);
      }
      const forecastBatch = await runForecastResolver();
      if (forecastBatch.resolved > 0) {
        logger.info(
          `Forecast resolver: resolved ${forecastBatch.resolved}/${forecastBatch.checked} expired forecast(s).`
        );
      }
    }
  );
  return true;
}
