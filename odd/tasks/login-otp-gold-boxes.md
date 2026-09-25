# Feature: login OTP gold boxes (OPT_Dinamico design)

## Goal
Restyle the BackOffice login (`/login`) so the OTP zone matches
`diseno/design/OPT_Dinamico.png`: six individual code boxes with a gold
focus state, gold full-width submit, centered layout, and gold accents
replicated across the rest of the login card.

## Design extraction (from OPT_Dinamico.png)
- Card: white, rounded, centered.
- Title bold dark, subtitle muted, centered.
- Label "Código de acceso" centered above the boxes.
- 6 boxes: light background, subtle border; active/focused box has gold
  border + ring and subtle gold tint; visible caret.
- Submit: full width, gold (`primary-500` #ab8620), white bold text.
- Gold text accents below the button.

## Constraints / decisions
- Login OTP wire alphabet is uppercase alphanumeric (A-Z0-9), NOT digits
  only. The shared `OtpInput` is digits-only and is used by 7 authed
  dialogs (marbetes, dispositivos, bulk upload) — extend it with an
  opt-in alphanumeric mode; default numeric behavior must stay identical.
- No "Reenviar código" action: OTP is pre-issued upstream; keep the
  existing hint text instead.
- Gold tokens already exist (`primary-500` #ab8620, `ring`). No global
  token changes.
- Branch: `feature/username-otp-dynamic-clean` (current). Work-unit
  commits stay on this branch.

## Tasks
1. [ ] Writer: extend `OtpInput` with alphanumeric mode + gold focus
      style; rework `login-form-otp.tsx` to use the boxes per design;
      polish `login/page.tsx` layout/accents; update/add unit tests.
2. [ ] Verify: focused unit tests, lint/typecheck/build, Playwright
      lookfeel login spec.
3. [ ] Work-unit commit(s) on the feature branch with evidence recorded.

## Evidence
- (commits recorded here after close)
