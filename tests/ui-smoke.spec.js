const { test, expect } = require('@playwright/test');

const boardCell = (boardLocator, row, col) =>
  boardLocator.locator(`button.cell[data-row="${row}"][data-col="${col}"]`);

test.describe('Command Deck smoke', () => {
  test('local PvA happy path: setup to playing and first shot', async ({ page }) => {
    await page.goto('/');

    const app = page.locator('.app');
    const status = page.locator('#status');
    await expect(app).toHaveAttribute('data-mode', 'local');
    await expect(app).toHaveAttribute('data-phase', 'setup');

    await page.locator('#btnStartLocal').click();
    await expect(app).toHaveAttribute('data-phase', 'playing');
    await expect(page.locator('#btnFire')).toBeEnabled();

    const beforeShot = await status.innerText();
    const enemyBoard = page.locator('#enemyBoard');
    await boardCell(enemyBoard, 0, 0).click();
    await expect(status).not.toHaveText(beforeShot);
  });

  test('manual placement feedback shows valid and invalid preview states', async ({ page }) => {
    await page.goto('/');
    await page.locator('#btnAdvancedToggle').click();
    await expect(page.locator('#advancedPanel')).toBeVisible();
    await page.locator('#btnClearPlacement').click();

    const ownBoard = page.locator('#myBoard');
    await boardCell(ownBoard, 0, 0).hover();
    await expect(ownBoard.locator('.cell--preview-valid')).toHaveCount(4);

    await boardCell(ownBoard, 0, 0).click();
    await boardCell(ownBoard, 1, 0).hover();
    await expect(ownBoard.locator('.cell--preview-invalid').first()).toBeVisible();
  });

  test('refresh keeps manual setup board empty before placement', async ({ page }) => {
    await page.goto('/');

    const app = page.locator('.app');
    const ownBoard = page.locator('#myBoard');
    await expect(app).toHaveAttribute('data-phase', 'setup');
    await expect(ownBoard.locator('.cell--ship')).toHaveCount(0);

    await page.reload();

    await expect(app).toHaveAttribute('data-phase', 'setup');
    await expect(ownBoard.locator('.cell--ship')).toHaveCount(0);
  });

  test('phase controls and advanced panel react to phase changes', async ({ page }) => {
    await page.goto('/');

    const app = page.locator('.app');
    const advancedToggle = page.locator('#btnAdvancedToggle');
    await expect(advancedToggle).toBeVisible();
    await expect(page.locator('#advancedPanel')).toBeHidden();
    await expect(app).toHaveAttribute('data-phase', 'setup');

    await advancedToggle.click();
    await expect(page.locator('#advancedPanel')).toBeVisible();

    await page.locator('#btnStartLocal').click();
    await expect(app).toHaveAttribute('data-phase', 'playing');
    await expect(page.locator('#btnFire')).toBeEnabled();
    await expect(page.locator('#btnPlayAgainOnline')).toBeDisabled();
  });

  test('mobile viewport keeps chat collapsed by default with launcher visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await expect(page.locator('#chatLauncher')).toBeVisible();
    await expect(page.locator('#chatPanel')).toHaveClass(/chat-panel--collapsed/);
  });

  test('chat launcher drag updates docking corner classes', async ({ page }) => {
    await page.goto('/');

    const launcher = page.locator('#chatLauncher');
    const panel = page.locator('#chatPanel');
    await expect(launcher).toHaveClass(/chat-corner-bottom-right/);

    const box = await launcher.boundingBox();
    if (!box) {
      throw new Error('Chat launcher is missing a bounding box.');
    }
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await launcher.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: startX,
      clientY: startY,
    });
    await launcher.dispatchEvent('pointermove', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 20,
    });
    await launcher.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 20,
    });

    await expect(launcher).toHaveClass(/chat-corner-top-left/);
    await expect(panel).toHaveClass(/chat-corner-top-left/);
  });

  test('reduced-motion mode still renders tactical shell correctly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    await expect(page.locator('#objectiveText')).toBeVisible();
    await expect(page.locator('#boardHelperText')).toBeVisible();

    await page.locator('#btnAdvancedToggle').click();
    await expect(page.locator('#advancedPanel')).toBeVisible();
  });
});
