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

test('cheat credential autofill cannot overwrite the saved player name', async ({ browser }) => {
  const context = await playerContext(browser, 'Raymond');
  const page = await context.newPage();

  try {
    await page.goto('/');
    for (let tap = 0; tap < 5; tap++) await page.locator('#panel-title').click();
    await expect(page.locator('#cheat-overlay')).toHaveClass(/show/);

    // Model a password manager filling its saved credential username into the
    // wrong visible field and firing the normal browser input event.
    await page.locator('#name-input').evaluate((input) => {
      input.value = 'Cheat_Code';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
    });

    await expect(page.locator('#name-input')).toHaveValue('Raymond');
    await page.locator('#cheat-cancel').click();
    await expect(page.locator('#name-input')).toHaveValue('Raymond');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('stackfall_name'))).toBe('Raymond');
  } finally {
    await context.close();
  }
});

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
    await host.route('**/cheat', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await host.goto('/');
    for (let tap = 0; tap < 5; tap++) await host.locator('#panel-title').click();
    await expect(host.locator('#cheat-overlay')).toHaveClass(/show/);
    await host.locator('#cheat-code').fill('e2e-multiplayer-secret');
    await host.locator('#cheat-unlock').click();
    await expect(host.locator('#cheat-menu')).toBeVisible();
    await host.locator('[data-cheat="autoPerfect"]').check();
    await host.locator('#cheat-resume').click();
    await expect(host.locator('#cheat-badge')).toBeVisible();

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
    await expect(host.locator('#cheat-badge')).toBeVisible();
    await host.locator('#game-wrap').click({ position: { x: 195, y: 420 } });
    await expect.poll(() => guestMessages.filter((message) => message.type === 'opponent_progress').length).toBeGreaterThan(0);
    const concealedProgress = guestMessages.find((message) => message.type === 'opponent_progress').payload.progress;
    expect(concealedProgress).not.toHaveProperty('cheated');

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
    await expect(host.locator('#cheat-badge')).toBeVisible();

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

async function submitChallengeResult(page, code, score){
  return page.evaluate(async ({ challengeCode, finalScore }) => {
    const key = `stackfall_beat_${challengeCode.replace(/-/g, '')}`;
    const session = JSON.parse(sessionStorage.getItem(key));
    const response = await fetch(`/challenges/${challengeCode}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        score: finalScore,
        floors: 3,
        perfects: 1,
        maxCombo: 1,
        combo: 0,
        widthRatio: 0.5,
        cheated: false,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { challengeCode: code, finalScore: score });
}

test('Beat My Tower can be claimed and completed later on the same seed', async ({ browser }) => {
  const hostContext = await playerContext(browser, 'Async Host');
  const guestContext = await playerContext(browser, 'Async Guest');
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  try {
    await host.goto('/');
    await host.locator('#beat-btn').click();
    await expect(host.locator('#duel-hud')).toBeVisible({ timeout: 10_000 });
    const code = new URL(host.url()).searchParams.get('beat');
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    const hostState = await host.evaluate(async (challengeCode) =>
      (await fetch(`/challenges/${challengeCode}`)).json(), code);
    const seed = hostState.challenge.seed;

    const hostFinish = await submitChallengeResult(host, code, 18);
    expect(hostFinish.status).toBe(200);
    expect(hostFinish.body.challenge.state).toBe('open');
    await host.reload();
    await expect(host.locator('#duel-title')).toHaveText('Challenge Ready');
    await expect(host.locator('#duel-share')).toBeVisible();

    await guest.goto(`/?beat=${code}`);
    await expect(guest.locator('#duel-title')).toHaveText('Beat Their Tower');
    await guest.locator('#duel-name').fill('Async Guest');
    await guest.locator('#duel-join-submit').click();
    await expect(guest.locator('#duel-hud')).toBeVisible({ timeout: 10_000 });
    const guestState = await guest.evaluate(async (challengeCode) =>
      (await fetch(`/challenges/${challengeCode}`)).json(), code);
    expect(guestState.challenge.seed).toBe(seed);

    const guestFinish = await submitChallengeResult(guest, code, 21);
    expect(guestFinish.status).toBe(200);
    expect(guestFinish.body.challenge.result.winner).toBe('guest');
    await guest.reload();
    await expect(guest.locator('#duel-title')).toHaveText('Easy Work.');
    await expect(guest.locator('#duel-rematch')).toBeHidden();
    await expect(guest.locator('#duel-result-my-score')).toHaveText('21');
    await expect(guest.locator('#duel-result-opponent-score')).toHaveText('18');
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});

test('exiting an unfinished Beat My Tower run cancels it and restores the title', async ({ browser }) => {
  const context = await playerContext(browser, 'Exit Check');
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.evaluate(() => history.replaceState({ stackfallDuel: true }, '', location.href));
    await page.locator('#beat-btn').click();
    await expect(page.locator('#duel-hud')).toBeVisible({ timeout: 10_000 });
    const code = new URL(page.url()).searchParams.get('beat');
    expect(code).toBeTruthy();

    await page.locator('#duel-forfeit').click();
    await expect(page.locator('#beat-btn')).toBeVisible();
    await expect(page).not.toHaveURL(/\?beat=/);
    const response = await page.request.get(`/challenges/${code}`);
    expect(response.status()).toBe(404);
  } finally {
    await context.close();
  }
});
