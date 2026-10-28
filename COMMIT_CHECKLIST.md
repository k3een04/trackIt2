# Commit checklist — review required

## ✅ Requirements met

1. **Single source of truth for notification styles**
   - All `.notif-*` rules are now in `visuals/trackit-glass.css`.
   - Duplicate rules removed from dashboard CSS (braces balanced, selector inventory clean).
   - No remaining `notif-*` rules in coordinator/supervisor/ojtdashboard.css.

2. **Bell and badge** (`#notif-btn`, `.notif-badge`)
   - 36px desktop, 44px mobile touch targets.
   - Expanded state styling with subtle teal border.
   - Count badge capped at `9+`; accessible label includes real unread count.
   - No fabricated dot; badge only indicator.

3. **Panel (popover) design**
   - Body-level fixed element (avoids backdrop-filter containing block).
   - Clamped to viewport; flips above bell when necessary.
   - `fade+slide` animation with reduced‑motion guard.
   - Header: title, unread count chip, quiet text actions (Mark all read / Clear all).
   - Clear all retains destructive tone with existing VerificationModal.
   - Internal scroll area for long lists.
   - Close on outside click and Escape; focus returns to bell.

4. **Rows**
   - Avatar: circular, initials from `actorName`, tinted by notification type.
   - Fallback to type icon when no actor.
   - Content: title (bold/unread), message (2‑line clamp), relative timestamp.
   - Subtle unread dot + row hover.
   - Keyboard‑activatable rows (Enter/Space marks read; dismiss with button).

5. **Empty / loading / error states**
   - Centered bell icon + "No notifications yet".
   - Loading stub and retry buttons preserved.

6. **Accessibility**
   - Bell: `aria-haspopup="dialog" aria-controls="notif-popup" aria-expanded="false"`.
   - Panel: `role="dialog" aria-label="Notifications"`.
   - Accessible names include real unread counts.
   - Keyboard navigation (tab, enter, space, escape).
   - Focus visible teal ring consistent with rest of dashboard.

7. **Responsive behavior**
   - Clamped position respects desktop/tablet/mobile.
   - Panel width: `min(380px, calc(100vw - 24px))`; mobile pin to viewport.
   - Touch targets meet 44px minimum.

8. **Real data integration**
   - No mock data; preserves existing backend routes (`/notifications`, PATCH /read, DELETE clear-all).
   - Polling, visibilitychange, refetch on open unchanged.
   - All three dashboards (Coordinator, Supervisor, Student/OJT) share identical logic.

## 📊 Files changed

| Category | Files |
|----------|-------|
| CSS (single source) | `visuals/trackit-glass.css` |
| Dashboard CSS (cleanup) | `visuals/coordinator-dashboard.css`, `visuals/supervisor-dashboard.css`, `visuals/ojtdashboard.css` |
| HTML (markup) | `coordinator-dashboard.html`, `supervisor-dashboard.html`, `ojtdashboard.html` |
| JS (logic) | `coordinator-dashboard.js`, `supervisor-dashboard.js`, `ojtdashboard.js` |
| Docs | `NOTIFICATION_REDESIGN.md` |

## 🧪 Verified

- **CSS**: selector inventory diff confirms only .notif-* rules removed from dashboard files.
- **Markup**: popup now body-level with aria attributes.
- **JS**: unified open/close/position functions; no duplicate definitions; all three dashboards behave identically.
- **Visuals**: preview harness shows dark/light, empty, long, and mobile mockups; anchoring math correct.
- **No regressions**: all existing API endpoints unchanged; polling, mark‑read, clear‑all flows preserved.

## 🚫 Uncommitted (deliberate)

- **Sidebar redesign** (previous task) – user chose not to commit.
- **Generated/temp assets** – cleaned up.

---

**Next:** commit with concise message (`feat: redesign notification bell and dropdown popover`) then `git push origin main` if desired.