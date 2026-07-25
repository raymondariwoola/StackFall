import { test, expect } from '@playwright/test';

function captureServerMessages(page, messages){
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message && message.type) messages.push(message);
      } catch (error) { /* ignore non-protocol frames */ }
    });
  });
}

async function playerContext(browser, name){
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((playerName) => {
    localStorage.setItem('stackfall_tutorial_seen', '1');
    localStorage.setItem('stackfall_name', playerName);
  }, name);
  return context;
}

test('two isolated players can forfeit and rematch on one shared seed', async ({ browser }) => {
  const hostContext = await playerContext(browser, 'E2E Host');
  const guestContext = await playerContext(browser, 'E2E Guest');
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const hostMessages = [];
  const guestMessages = [];
  captureServerMessages(host, hostMessages);
  captureServerMessages(guest, guestMessages);

  try {
    await host.goto('/');
    await host.locator('#challenge-btn').click();
    await expect(host.locator('#duel-room-code')).toBeVisible();
    const code = (await host.locator('#duel-room-code').textContent()).trim();
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);

    await guest.goto(`/?duel=${code}`);
    await expect(guest.locator('#duel-join-view')).toBeVisible();
    await guest.locator('#duel-name').fill('E2E Guest');
    await guest.locator('#duel-join-submit').click();
    await expect(host.locator('#duel-guest-name')).toHaveText('E2E Guest');

    await host.locator('#duel-ready').click();
    await guest.locator('#duel-ready').click();
    await expect(host.locator('#duel-countdown')).toBeVisible();
    await expect(guest.locator('#duel-countdown')).toBeVisible();
    await expect(host.locator('#duel-hud')).toBeVisible({ timeout: 10_000 });
    await expect(guest.locator('#duel-hud')).toBeVisible({ timeout: 10_000 });
    await expect(host.locator('#settings-btn')).toBeHidden();
    await expect(host.locator('#pause-btn')).toBeHidden();

    const firstHostCountdown = hostMessages.find((message) => message.type === 'countdown');
    const firstGuestCountdown = guestMessages.find((message) => message.type === 'countdown');
    expect(firstHostCountdown.payload.seed).toBe(firstGuestCountdown.payload.seed);
    expect(firstHostCountdown.payload.difficulty).toBe(firstGuestCountdown.payload.difficulty);

    await guest.locator('#duel-forfeit').click();
    await expect(host.locator('#duel-title')).toHaveText('You Win!');
    await expect(guest.locator('#duel-title')).toHaveText('Good Duel');

    await host.locator('#duel-rematch').click();
    await guest.locator('#duel-rematch').click();
    await expect(host.locator('#duel-countdown')).toBeVisible();
    await expect(host.locator('#duel-hud')).toBeVisible({ timeout: 10_000 });

    const hostCountdowns = hostMessages.filter((message) => message.type === 'countdown');
    const guestCountdowns = guestMessages.filter((message) => message.type === 'countdown');
    expect(hostCountdowns).toHaveLength(2);
    expect(guestCountdowns).toHaveLength(2);
    expect(hostCountdowns[1].payload.seed).toBe(guestCountdowns[1].payload.seed);
    expect(hostCountdowns[1].payload.seed).not.toBe(hostCountdowns[0].payload.seed);

    await host.setViewportSize({ width: 844, height: 390 });
    await expect(host.locator('#duel-hud')).toBeVisible();
    const landscapeHud = await host.locator('#duel-hud').boundingBox();
    expect(landscapeHud.x).toBeGreaterThanOrEqual(0);
    expect(landscapeHud.x + landscapeHud.width).toBeLessThanOrEqual(844);
    await host.setViewportSize({ width: 390, height: 844 });

    await host.locator('#duel-forfeit').click();
    await expect(guest.locator('#duel-title')).toHaveText('You Win!');
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
