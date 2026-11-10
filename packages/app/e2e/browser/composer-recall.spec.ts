import { expect, test, type Page } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";

function userMessages(page: Page) {
  return page.getByTestId("user-message");
}

async function sendDraftWhenReady(page: Page) {
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await pressInComposer(page, "Enter");
}

async function sendAndWaitForMessage(page: Page, text: string, expectedCount: number) {
  await fillComposerDraft(page, text);
  await sendDraftWhenReady(page);
  await expect(userMessages(page)).toHaveCount(expectedCount, { timeout: 30_000 });
  await expectComposerDraft(page, "");
}

async function pressInComposer(page: Page, key: string) {
  await composerLocator(page).press(key);
}

test.describe("Composer recall", () => {
  test("Up and Down walk sent messages from an empty composer", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-recall-",
      title: "Composer recall",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await sendAndWaitForMessage(page, "fix the auth bug", 1);
      await sendAndWaitForMessage(page, "add tests", 2);

      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "add tests");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "fix the auth bug");
      await pressInComposer(page, "ArrowDown");
      await expectComposerDraft(page, "add tests");
      await pressInComposer(page, "ArrowDown");
      await expectComposerDraft(page, "");

      await pressInComposer(page, "ArrowUp");
      await typeIntoFocusedComposer(page, " for login");
      await expectComposerDraft(page, "add tests for login");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "add tests for login");

      await sendDraftWhenReady(page);
      await expect(userMessages(page)).toHaveCount(3, { timeout: 30_000 });
      await expect(userMessages(page).last()).toContainText("add tests for login");
    } finally {
      await session.cleanup();
    }
  });

  test("a recalled slash message does not open the command picker", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-recall-slash-",
      title: "Composer recall slash",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await sendAndWaitForMessage(page, "/tdd", 1);

      const popover = page.getByTestId("composer-autocomplete-popover").filter({ visible: true });
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "/tdd");
      await expect(popover).toHaveCount(0);

      await typeIntoFocusedComposer(page, "x");
      await expect(popover.first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await session.cleanup();
    }
  });

  test("Up walks past a multi-line message to the one before it", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-recall-multiline-",
      title: "Composer recall multi-line",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await sendAndWaitForMessage(page, "fix the auth bug", 1);
      await sendAndWaitForMessage(page, "add tests\nfor the login form", 2);
      await sendAndWaitForMessage(page, "run them", 3);

      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "run them");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "add tests\nfor the login form");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "fix the auth bug");
      await pressInComposer(page, "ArrowDown");
      await expectComposerDraft(page, "add tests\nfor the login form");

      await pressInComposer(page, "Home");
      await pressInComposer(page, "ArrowUp");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "add tests\nfor the login form");
    } finally {
      await session.cleanup();
    }
  });

  test("Up reaches messages older than the loaded timeline without loading them into it", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 45 });
    try {
      await openAgentTimeline(page, agent);
      await expectComposerVisible(page);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      for (const prompt of agent.prompts.toReversed()) {
        await pressInComposer(page, "ArrowUp");
        await expectComposerDraft(page, prompt);
      }
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await pressInComposer(page, "ArrowDown");
      await expectComposerDraft(page, agent.prompts[1]);
    } finally {
      await agent.cleanup();
    }
  });
});
