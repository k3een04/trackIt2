# Brief for commit reviewer

## Objective
- Redesign the TrackIT notification bell + dropdown popover (all three dashboards) to a refined SaaS look, preserving all existing notification functionality, data, and API behavior.
- Sidebar redesign (previous task) is complete and verified; user declined to commit it.

## What was changed (summary)

### Core design consolidation
- **Single source stylesheet**: All `.notif-*` rules are now in `visuals/trackit-glass.css`. Duplicate rules removed from coordinator-, supervisor-, and ojtdashboard.css.
- **Bell**: 36px desktop, 44px mobile, expanded state with subtle teal border, count badge capped at `9+`. No separate unread dot.
- **Panel**: body-level fixed element (avoids nav backdrop-filter containing block). Clamped to viewport; flips above bell when needed. Fade+slide animation with reduced‑motion guard. Header: title, unread count chip, quiet text actions (Mark all read / Clear all). Clear all retains destructive tone with existing VerificationModal.
- **Rows**: Avatar = initials from `actorName` (type‑tinted) or fallback type icon. Content: title (bold/unread), message (2‑line clamp), relative timestamp. Subtle unread dot + row hover.
- **Accessibility**: Bell has `aria-haspopup="dialog" aria-controls="notif-popup" aria-expanded="false"`. Panel is `role="dialog"`. Accessible names include real unread counts. Keyboard navigation (tab, enter, space, escape). Focus visible teal ring consistent.
- **Empty/loading/error**: Centered bell icon + "No notifications yet". Loading stub and retry buttons preserved.

### Architecture updates
- Removed duplicate notif rules from dashboard CSS.
- Moved #notif-popup from header to body in all three dashboard HTMLs; added aria attributes.
- Refactored JS: unified open/close/position logic across all three dashboards (same functions). Added `notificationInitials()` and `notifType()` helpers.
- Preserved existing API flows (GET /notifications, PATCH /read, DELETE clear-all, polling).

### Code hygiene
- Cleaned up temporary scripts (`tmp_*.js`) and preview images.
- Cache‑bumped CSS versions (`trackit-glass.css?v=5`, dashboard CSS +18/24).
- Verified responsive mockups (dark/light, empty, long, mobile) via browser screenshots.

### What was **not** changed
- Header/dashboard content, routes, schemas, authentication.
- Existing notification behaviors (polling, mark‑read, clear‑all, unread counts).
- Backend API: no modifications.
- Sidebar work (remains uncommitted per user choice).

## Key decisions

1. **Avatar source**: Initials from `actorName` tinted by type (no backend change, no real profile pictures).
2. **Panel anchoring**: Body‑level, JS‑anchored (same pattern as global search). Avoids backdrop‑filter containing block.
3. **Row click action**: Mark read only (no navigation).
4. **Header actions**: Both kept, restyled as quiet text actions; Clear all stays destructive.
5. **Bell and badge**: 44px on mobile, 36px desktop, count only (no separate dot).

## Ready for commit
- All changes are staged (`git add .`).
- No accidental modifications introduced.
- Files changed are limited to the three dashboards + shared stylesheet.

**Next steps:**
1. Review changes (Commit checklist attached).
2. `git commit -m "feat: redesign notification bell and dropdown popover"`
3. `git push origin main` (if permitted).

---
All three dashboards now share a single, production‑ready notification system that matches the desired SaaS aesthetic while preserving the existing feature set.