# T19 — Task drag, rescheduling and ordering

Status: implementation complete locally on `feature/task-drag-reordering`; PR and GitHub CI pending.

## Delivered

- Added native task-card dragging within the visible work week, with a small drag preview, a dimmed source, an explicitly labeled destination day/period, highlighted drop bucket, and a labeled insertion marker. Scrolling near the viewport edges continues the shared page scroll. Dropping outside the week, canceling, or dropping in the current position leaves the task unchanged.
- Added keyboard controls to move each task earlier or later in its bucket. Opening the task form remains the keyboard-accessible way to set a date and period, including dates outside the visible week.
- Reordered single tasks through guarded `set_order` mutations. The local operation checks the source/destination bucket hashes and affected root hashes; rank maintenance only touches the local range needed when neighboring ranks have no gap. A date/period change and its insertion rank commit together.
- Added an eight-second “Hoàn tác” toast that pauses while hovered or focused. The latest action stays in the calendar widget after the toast expires, and is cleared by the next local calendar mutation, owner logout/switch, or reload.
- Undo is a new sync mutation with the original operation dependency and expected hashes for every root changed by the reorder. If any affected task has changed, the reducer rejects the undo and the UI reports why.
- Milestones have no drag affordance and are not moved by task operations.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm build:web` | Passed |
| `git diff --check` | Passed |
| Focused local Playwright task flow | Not run to completion: the configured Chromium executable is absent on this workstation; test discovery found all 16 auth-session cases |
| GitHub CI and Offline web shell | Pending PR |

The added browser scenario covers keyboard reordering, undo, dragging across day and period, Escape and outside-drop cancellation, rescheduling with the task form, and keeping milestones non-draggable. GitHub CI will run the suite with its pinned Playwright browser.
