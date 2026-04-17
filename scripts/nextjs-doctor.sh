#!/usr/bin/env bash
# nextjs-doctor — Check Next.js projects for common pitfalls
# Usage: nextjs-doctor [project-dir]
# Runs after engineer/overhaul to catch issues before deploy.

set -euo pipefail

DIR="${1:-.}"
ERRORS=0
WARNS=0

# Colors
RED='\033[0;31m'
YEL='\033[0;33m'
GRN='\033[0;32m'
NC='\033[0m'

err()  { echo -e "${RED}❌ $1${NC}"; ERRORS=$((ERRORS+1)); }
warn() { echo -e "${YEL}⚠️  $1${NC}"; WARNS=$((WARNS+1)); }
ok()   { echo -e "${GRN}✅ $1${NC}"; }

echo "🔍 nextjs-doctor scanning: $DIR"
echo ""

# ── 1. Check Next.js version ──
NEXT_VER=""
if [ -f "$DIR/package.json" ]; then
  NEXT_VER=$(python3 -c "import json; d=json.load(open('$DIR/package.json')); v=d.get('dependencies',{}).get('next',''); print(v.lstrip('^~'))" 2>/dev/null || echo "")
fi

if [ -z "$NEXT_VER" ]; then
  err "No Next.js dependency found in package.json"
  exit 1
fi
echo "📦 Next.js version: $NEXT_VER"
echo ""

# ── 2. Async Params (Next.js 15+) ──
echo "── Async Params Check ──"
MAJOR=$(echo "$NEXT_VER" | cut -d. -f1)
if [ "$MAJOR" -ge 15 ] 2>/dev/null; then
  # Find all dynamic route pages
  DYNAMIC_FILES=$(find "$DIR/src" "$DIR/app" -path "*/\[*\]/*.tsx" -o -path "*/\[*\]/*.ts" 2>/dev/null | grep -v node_modules | grep -v .next || true)
  
  if [ -n "$DYNAMIC_FILES" ]; then
    SYNC_PARAMS=0
    while IFS= read -r f; do
      # Check for sync params pattern: { params }: { params: { 
      if grep -q 'params\s*}:\s*{\s*params:\s*{' "$f" 2>/dev/null && ! grep -q 'params:\s*Promise' "$f" 2>/dev/null; then
        err "Sync params in $f — Next.js $MAJOR requires: params: Promise<{...}> + await"
        SYNC_PARAMS=$((SYNC_PARAMS+1))
      fi
      # Also check for direct params.slug without await
      if grep -q 'params\.\w' "$f" 2>/dev/null && ! grep -q 'await\s*params' "$f" 2>/dev/null && grep -q 'params' "$f" 2>/dev/null; then
        # More precise: check if function is async and params is awaited
        if ! grep -q 'async.*function\|async.*=>' "$f" 2>/dev/null; then
          warn "Non-async function using params in $f — may need async + await params"
        fi
      fi
    done <<< "$DYNAMIC_FILES"
    
    if [ "$SYNC_PARAMS" -eq 0 ]; then
      ok "All dynamic routes use async params"
    fi
  else
    ok "No dynamic routes found"
  fi
else
  ok "Next.js $NEXT_VER — async params not required"
fi

# ── 3. SSG + Server Routes Conflict ──
echo ""
echo "── SSG / Server Routes Conflict ──"
HAS_EXPORT=$(grep -r 'output.*export' "$DIR/next.config"* 2>/dev/null | head -1 || true)
HAS_API_ROUTES=$(find "$DIR/src/app/api" "$DIR/app/api" -name "route.ts" -o -name "route.js" 2>/dev/null | head -1 || true)
HAS_LOGTO=$(grep -r '@logto' "$DIR/package.json" 2>/dev/null || true)
HAS_SERVER_ACTIONS=$(find "$DIR/src" "$DIR/app" -name "*.ts" -o -name "*.tsx" 2>/dev/null | xargs grep -l "use server" 2>/dev/null | head -1 || true)

if [ -n "$HAS_EXPORT" ]; then
  if [ -n "$HAS_API_ROUTES" ] || [ -n "$HAS_LOGTO" ] || [ -n "$HAS_SERVER_ACTIONS" ]; then
    err "output: \"export\" (SSG) conflicts with API routes / Logto / server actions"
    [ -n "$HAS_API_ROUTES" ] && echo "     Found: API routes in $(dirname "$HAS_API_ROUTES")"
    [ -n "$HAS_LOGTO" ] && echo "     Found: @logto/next requires server-side routes"
    [ -n "$HAS_SERVER_ACTIONS" ] && echo "     Found: 'use server' directive"
  else
    ok "output: \"export\" — pure SSG, no server conflicts"
  fi
else
  ok "No output: \"export\" — server routes supported"
fi

# ── 4. generateStaticParams Check ──
echo ""
echo "── generateStaticParams Check ──"
if [ -n "$(find "$DIR/src" "$DIR/app" -path "*/\[*\]/*.tsx" -o -path "*/\[*\]/*.ts" 2>/dev/null | grep -v node_modules | grep -v .next | head -1)" ]; then
  MISSING_GSP=0
  DYNAMIC_PAGES=$(find "$DIR/src" "$DIR/app" -path "*/\[*\]/page.tsx" -o -path "*/\[*\]/page.ts" 2>/dev/null | grep -v node_modules | grep -v .next || true)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! grep -q "generateStaticParams" "$f" 2>/dev/null; then
      warn "No generateStaticParams in $f — pages won't be pre-rendered"
      MISSING_GSP=$((MISSING_GSP+1))
    fi
  done <<< "$DYNAMIC_PAGES"
  
  if [ "$MISSING_GSP" -eq 0 ]; then
    ok "All dynamic pages have generateStaticParams"
  fi
else
  ok "No dynamic route pages"
fi

# ── 5. Image Optimization Check ──
echo ""
echo "── Images Check ──"
# Check for external images without domains config
EXT_IMAGES=$(find "$DIR/src" "$DIR/app" -name "*.tsx" -o -name "*.ts" 2>/dev/null | xargs grep -l "next/image" 2>/dev/null | head -1 || true)
if [ -n "$EXT_IMAGES" ]; then
  # Check if images config exists
  if ! grep -q "images" "$DIR/next.config"* 2>/dev/null; then
    warn "Using next/image but no images config in next.config — external images will fail"
  else
    ok "next/image with images config present"
  fi
else
  # Check for raw <img> tags with external URLs
  RAW_IMGS=$(find "$DIR/src" "$DIR/app" -name "*.tsx" 2>/dev/null | xargs grep -c '<img.*src=' 2>/dev/null | grep -v ':0$' | head -3 || true)
  if [ -n "$RAW_IMGS" ]; then
    ok "Using raw <img> tags (no next/image optimization)"
  else
    ok "No image issues detected"
  fi
fi

# ── 6. DaisyUI Theme Check ──
echo ""
echo "── DaisyUI Theme Check ──"
HAS_DAISYUI=$(grep -q 'daisyui' "$DIR/package.json" 2>/dev/null && echo "yes" || true)
if [ "$HAS_DAISYUI" = "yes" ]; then
  HAS_DATA_THEME=$(find "$DIR/src" "$DIR/app" -name "*.tsx" 2>/dev/null | xargs grep -l 'data-theme' 2>/dev/null | head -1 || true)
  if [ -n "$HAS_DATA_THEME" ]; then
    # Check if theme is registered in CSS/config
    HAS_THEME_REG=$(grep -r '@plugin.*daisyui\|daisyui.*themes\|@theme' "$DIR/src/app/globals.css" "$DIR/tailwind.config"* 2>/dev/null | head -1 || true)
    if [ -z "$HAS_THEME_REG" ]; then
      warn "data-theme used but theme may not be registered in CSS — DaisyUI v5 requires explicit theme activation"
    else
      ok "DaisyUI theme configured"
    fi
  else
    ok "DaisyUI present, no data-theme attribute"
  fi
else
  ok "No DaisyUI"
fi

# ── 7. Metadata Check ──
echo ""
echo "── SEO Metadata Check ──"
ROOT_LAYOUT=$(find "$DIR/src/app" "$DIR/app" -maxdepth 1 -name "layout.tsx" -o -name "layout.ts" 2>/dev/null | head -1 || true)
if [ -n "$ROOT_LAYOUT" ]; then
  if ! grep -q "metadata\|generateMetadata" "$ROOT_LAYOUT" 2>/dev/null; then
    warn "No metadata export in root layout.tsx"
  else
    ok "Root layout has metadata"
  fi

  # Check for sitemap
  HAS_SITEMAP=$(find "$DIR/src/app" "$DIR/app" -maxdepth 1 -name "sitemap.*" 2>/dev/null | head -1 || true)
  if [ -z "$HAS_SITEMAP" ]; then
    warn "No sitemap.ts/xml found"
  else
    ok "Sitemap present"
  fi
else
  warn "No root layout found"
fi

# ── Summary ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}🔴 $ERRORS error(s), $WARNS warning(s)${NC}"
  exit 1
elif [ "$WARNS" -gt 0 ]; then
  echo -e "${YEL}🟡 0 errors, $WARNS warning(s)${NC}"
  exit 0
else
  echo -e "${GRN}🟢 All checks passed${NC}"
  exit 0
fi
