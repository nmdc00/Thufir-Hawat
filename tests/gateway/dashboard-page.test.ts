import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleDashboardPageRequest, resolveDashboardDistDir } from '../../src/gateway/dashboard_page.js';

describe('dashboard page route', () => {
  let dashboardDir: string | null = null;
  const originalDist = process.env.THUFIR_DASHBOARD_DIST_PATH;

  afterEach(() => {
    process.env.THUFIR_DASHBOARD_DIST_PATH = originalDist;
    if (dashboardDir) {
      rmSync(dashboardDir, { recursive: true, force: true });
      dashboardDir = null;
    }
  });

  it('serves inline dashboard html on GET /dashboard when no built dist is available', () => {
    dashboardDir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-inline-'));
    process.env.THUFIR_DASHBOARD_DIST_PATH = dashboardDir;
    const req = {
      method: 'GET',
      url: '/dashboard',
      headers: { host: 'localhost:18789' },
    } as any;

    const state: { status?: number; body?: string; contentType?: string } = {};
    const res = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        state.status = status;
        state.contentType = headers?.['Content-Type'];
      },
      end: (body?: string) => {
        state.body = body;
      },
    } as any;

    const handled = handleDashboardPageRequest(req, res);
    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    expect(state.contentType).toContain('text/html');
    expect(state.body).toContain('Thufir Dashboard');
    expect(state.body).toContain('Overview');
    expect(state.body).toContain('Learning');
    expect(state.body).toContain('Comparable Prediction Accuracy');
    expect(state.body).toContain('Total Considered');
    expect(state.body).toContain('Missing Comparator');
    expect(state.body).toContain('Synthetic Blocked');
    expect(state.body).toContain('Insufficient Samples');
    expect(state.body).toContain('Perp prediction candidates exist, but none have final outcomes yet.');
    expect(state.body).toContain('missing a real comparator baseline');
    expect(state.body).toContain('Exclusion Reasons');
  });

  it('serves built static index and assets when dashboard-dist exists', () => {
    dashboardDir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-dist-'));
    const assetsDir = join(dashboardDir, 'assets');
    rmSync(assetsDir, { recursive: true, force: true });
    writeFileSync(join(dashboardDir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="/dashboard/assets/app.js"></script></body></html>');
    process.env.THUFIR_DASHBOARD_DIST_PATH = dashboardDir;

    const pageState: { status?: number; body?: string; contentType?: string } = {};
    const pageRes = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        pageState.status = status;
        pageState.contentType = headers?.['Content-Type'];
      },
      end: (body?: string) => {
        pageState.body = body;
      },
    } as any;

    const handled = handleDashboardPageRequest({
      method: 'GET',
      url: '/dashboard',
      headers: { host: 'localhost:18789' },
    } as any, pageRes);

    expect(handled).toBe(true);
    expect(pageState.status).toBe(200);
    expect(pageState.contentType).toContain('text/html');
  });

  it('returns false for non-dashboard paths', () => {
    const req = {
      method: 'GET',
      url: '/not-dashboard',
      headers: { host: 'localhost:18789' },
    } as any;
    const res = {
      writeHead: () => undefined,
      end: () => undefined,
    } as any;

    expect(handleDashboardPageRequest(req, res)).toBe(false);
  });

  it('falls back to the repo-root dashboard-dist when running from dist/gateway', () => {
    const distDir = resolveDashboardDistDir({
      envPath: '',
      moduleDir: '/opt/bijaz/dist/gateway',
      exists: () => false,
    });

    expect(distDir).toBe('/opt/bijaz/src/gateway/dashboard-dist');
  });
});
