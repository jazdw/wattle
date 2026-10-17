// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaidGlobal } from './plaidLink';

const SCRIPT = 'script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]';

/** A fresh copy of the module (its "already loading" state is per page). */
async function freshModule() {
  vi.resetModules();
  return import('./plaidLink');
}

function fakePlaid() {
  const handler = { open: vi.fn(), exit: vi.fn(), destroy: vi.fn() };
  let options: Parameters<PlaidGlobal['create']>[0] | undefined;
  const Plaid: PlaidGlobal = {
    create: (given) => {
      options = given;
      return handler;
    },
  };
  return { Plaid, handler, options: () => options! };
}

beforeEach(() => {
  delete window.Plaid;
  document.head.innerHTML = '';
});

describe('loadPlaid', () => {
  it('adds the script once, however many times it is asked for', async () => {
    const { loadPlaid } = await freshModule();
    const first = loadPlaid();
    const second = loadPlaid();
    expect(document.querySelectorAll(SCRIPT)).toHaveLength(1);

    const { Plaid } = fakePlaid();
    window.Plaid = Plaid;
    document.querySelector(SCRIPT)!.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(Plaid);
    await expect(second).resolves.toBe(Plaid);
    await expect(loadPlaid()).resolves.toBe(Plaid);
    expect(document.querySelectorAll(SCRIPT)).toHaveLength(1);
  });

  it('reuses a script tag already on the page', async () => {
    const existing = document.createElement('script');
    existing.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    document.head.appendChild(existing);
    const { loadPlaid } = await freshModule();
    const loaded = loadPlaid();
    window.Plaid = fakePlaid().Plaid;
    existing.dispatchEvent(new Event('load'));
    await loaded;
    expect(document.querySelectorAll(SCRIPT)).toHaveLength(1);
  });

  it('can try again after the script fails to download', async () => {
    const { loadPlaid } = await freshModule();
    const failed = loadPlaid();
    document.querySelector(SCRIPT)!.dispatchEvent(new Event('error'));
    await expect(failed).rejects.toThrow(/Could not load Plaid Link/);
    expect(document.querySelectorAll(SCRIPT)).toHaveLength(0);

    const retry = loadPlaid();
    expect(document.querySelectorAll(SCRIPT)).toHaveLength(1);
    window.Plaid = fakePlaid().Plaid;
    document.querySelector(SCRIPT)!.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBe(window.Plaid);
  });
});

describe('openPlaidLink', () => {
  it('opens once loaded and tears down after success', async () => {
    const { openPlaidLink } = await freshModule();
    const plaid = fakePlaid();
    window.Plaid = plaid.Plaid;
    const onSuccess = vi.fn();
    await openPlaidLink('link-token', { onSuccess, onExit: vi.fn() });
    expect(plaid.options().token).toBe('link-token');
    expect(plaid.handler.open).not.toHaveBeenCalled();
    plaid.options().onLoad!();
    expect(plaid.handler.open).toHaveBeenCalledOnce();
    plaid.options().onSuccess('public-token');
    expect(onSuccess).toHaveBeenCalledWith('public-token');
    expect(plaid.handler.destroy).toHaveBeenCalledOnce();
  });

  it("passes on Plaid's error message when Link exits", async () => {
    const { openPlaidLink } = await freshModule();
    const plaid = fakePlaid();
    window.Plaid = plaid.Plaid;
    const onExit = vi.fn();
    await openPlaidLink('link-token', { onSuccess: vi.fn(), onExit });
    plaid.options().onExit({ error_message: 'internal', display_message: 'The bank is down.' });
    expect(onExit).toHaveBeenCalledWith('The bank is down.');
    plaid.options().onExit(null);
    expect(onExit).toHaveBeenCalledOnce();
    expect(plaid.handler.destroy).toHaveBeenCalledOnce();
  });

  it('closing before Link loads stops it from opening', async () => {
    const { openPlaidLink } = await freshModule();
    const plaid = fakePlaid();
    window.Plaid = plaid.Plaid;
    const onExit = vi.fn();
    const close = await openPlaidLink('link-token', { onSuccess: vi.fn(), onExit });
    close();
    plaid.options().onLoad!();
    expect(plaid.handler.open).not.toHaveBeenCalled();
    expect(plaid.handler.destroy).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });
});
