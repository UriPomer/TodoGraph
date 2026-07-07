# Mobile UI Adjustment

## Direction

The mobile UI should not replace TodoGraph's core desktop visual language. The
main work area keeps the current product style:

- dark canvas and muted dotted grid
- compact dark task/group nodes
- purple node anchors
- green dashed dependency edges
- dense task information rather than large white cards

The mobile redesign applies mainly to the shell around that core:

- a compact mobile top bar for title, page selection, and key actions
- a bottom navigation with `Tasks`, `Graph`, and `More`
- a mobile `More` page for account security, data, AI/MCP, and account actions

## Screen Rules

### Tasks

- Keep the list close to the current desktop left panel.
- Use section labels such as `READY`, `Blocked`, and `Done`.
- Avoid marketing-style cards such as a large "today focus" block.
- Preserve dense task rows and hierarchy affordances.
- Do not render task sections or task rows as rounded card stacks.
- Use a continuous tree/table surface with thin dividers, status dots, and a
  20px content inset.
- Keep the mobile task surface lightly frosted so the background remains
  visible.

### Graph

- The graph page is the product center.
- Keep React Flow as the main surface on mobile.
- Use the same dark canvas treatment as desktop.
- Mobile-only chrome should not obscure the graph more than necessary.

### More

- Keep the new information architecture:
  - Security
  - Data
  - Integrations and AI
  - Account
- Match the dark shell and compact list style.
- Use real icon components rather than text glyph placeholders.

## Implementation Notes

- Desktop layout remains unchanged.
- Mobile styles should be scoped with responsive classes or mobile-only class
  names.
- Existing graph/list components should be reused. Do not fork the graph for
  mobile unless a specific interaction requires it.
- Tests should assert the mobile shell keeps the dark product surface and does
  not regress the More page entry points.
