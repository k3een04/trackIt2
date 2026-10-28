All work completed. Summary of changes:

## ✅ Notification redesign completed

### **Styles** (single source: `visuals/trackit-glass.css`)
- **Removed duplicate notif rules** from coordinator, supervisor, and ojtdashboard CSS files.
- **Consolidated popover styling** in the shared stylesheet (body-level, JS-anchored due to backdrop-filter trap).
- **Bell** (`#notif-btn`): 36px desktop, 44px touch, expanded state, subtle border/teal ring on focus.
- **Badge**: --teal chip, capped 9+, accessible label includes real unread count.
- **Panel**: fixed, clamped, fade+slide animation, close on outside/Escape, own scroll area.
- **Rows**: avatar = initials (type-tinted) or fallback icon, title, message, relative timestamp, subtle unread dot.
- **Header**: quiet text actions, unread count chip.
- **Empty state**: centered bell icon + text.
- **Light/Dark parity** with semantic colors.

### **Frontend logic** (coordinator-dashboard.js, supervisor-dashboard.js, ojtdashboard.js)
- **Unified functions**: `positionNotifPopup()` (viewport clamping), `openNotifications()`, `closeNotifications()`, `toggleNotifications()`.
- **Refresh logic**: load on open, 60s polling, focus/tab visibility.
- **Keyboard**: Escape closes, bell focus restored; rows clickable (mark read) and dismissible.
- **Badge update**: real number in header, chip capped.
- **Avatar rendering**: `notificationInitials()`; type icon when missing actor.
- **Accessibility**: ARIA roles (dialog), aria-expanded, aria-label for bell includes count.
- **API preserved**: existing endpoints (`/notifications`, PATCH /read, DELETE clear-all, etc.) untouched.

### **Markup** (coordinator-dashboard.html, supervisor-dashboard.html, ojtdashboard.html)
- **Removed in-header popup**, added body-level `<div id="notif-popup" class="notif-popup" role="dialog" aria-label="Notifications">`.
- **Bell attributes**: `aria-haspopup="dialog" aria-controls="notif-popup" aria-expanded="false"`.
- **Header**: title, `<span id="notif-count" class="notif-count" hidden></span>`, restyled quiet actions.

### **Cache and verification**
- **Bumped CSS versions**: `trackit-glass.css?v=5`, coordinator-dashboard.css?v=24, supervisor-dashboard.css?v=7, ojtdashboard.css?v=18.
- **Sanitized CSS**: brace-balanced, selector inventory shows only .notif-* removed from dashboard files.
- **Clean temp scripts**: all `	mp_strip_notif*.js`, `tmp_compare_selectors.js`, `tmp_fix_braces.js` deleted.
- **Verified functionality**: built preview harness with dark/light, empty, long, mobile states, anchored clamping.
- **No functional regressions**: existing flows (polling, mark-read, clear-all, unread states) preserved across all three dashboards.

## 📋 What was **not** changed
- **Header/dashboard content, routes, schemas, auth** – preserved.
- **Real API integration** – all backend routes unchanged.
- **Existing notification behavior** – polling, mark/read, clear-all, empty states untouched.
- **Theme tokens** – used existing design system variables.
- **Sidebar** – previous work remains uncommitted as per user choice.

## 🔧 Next steps for commit
The repository now has a clean, single-source notification system with refined SaaS styling while preserving all existing functionality across Coordinator, Supervisor, and Student dashboards. The work is ready for verification and commit if desired.