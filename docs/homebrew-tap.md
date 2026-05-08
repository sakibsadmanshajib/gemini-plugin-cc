# Homebrew tap setup

Homebrew formulas for third-party packages live in **tap repositories**
named `homebrew-<tap>`. To make `brew install artagon/tap/artagon-agent-cli-plugin`
work, we ship a separate `artagon/homebrew-tap` repo containing one
formula file. This doc captures the bootstrap recipe + the update
procedure when the npm package version bumps.

This formula is **not yet published**. Publish blockers:

1. Tap repo `artagon/homebrew-tap` doesn't exist on GitHub yet.
2. The npm package hasn't been published yet (the publish workflow at
   `.github/workflows/npm-publish.yml` triggers on `v*` tag push).

## One-time tap bootstrap

```sh
# Create the tap repo on GitHub (do this once)
gh repo create artagon/homebrew-tap --public \
  --description "Homebrew tap for Artagon tools"

# Clone + scaffold
git clone git@github.com:artagon/homebrew-tap.git
cd homebrew-tap
mkdir -p Formula
```

Add `Formula/artagon-agent-cli-plugin.rb` with the template below, commit,
push.

## Formula template

```ruby
class ArtagonAgentCliPlugin < Formula
  desc     "Multi-backend agent CLI plugin suite for Claude, Codex, and Gemini"
  homepage "https://github.com/artagon/artagon-agent-cli-plugin"
  url      "https://registry.npmjs.org/artagon-agent-cli-plugin/-/artagon-agent-cli-plugin-1.0.1.tgz"
  sha256   "REPLACE_WITH_SHA256_OF_TARBALL"
  license  "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Smoke test: --version must print the package version.
    assert_match version.to_s, shell_output("#{bin}/artagon-agent --version")

    # Smoke test: --help must mention all three backends.
    help_output = shell_output("#{bin}/artagon-agent --help")
    assert_match "claude, codex, gemini", help_output

    # Smoke test: openai-server entry binary is installed.
    assert_predicate bin/"artagon-openai-server", :executable?
  end
end
```

## Generating the formula automatically

After `git tag -s v<NEW> && git push --tags` triggers the
npm-publish workflow and the version is live on npm, the simplest
path is the in-repo generator:

```sh
# In a checkout of artagon-agent-cli-plugin:
pnpm gen:homebrew --output /path/to/homebrew-tap/Formula/artagon-agent-cli-plugin.rb
# Or print to stdout to inspect first:
pnpm gen:homebrew
```

The generator (`scripts/generate-homebrew-formula.mjs`) reads
`package.json` for the version + name, fetches the published tarball
from registry.npmjs.org, computes the SHA-256, and renders the
formula. `--version <v>` overrides if you need a different release.

If you'd rather do it by hand:

```sh
# Download the published tarball + compute SHA
NPM_PKG=artagon-agent-cli-plugin
NPM_VER=1.0.1
curl -sL "https://registry.npmjs.org/${NPM_PKG}/-/${NPM_PKG}-${NPM_VER}.tgz" \
  | shasum -a 256 | cut -d' ' -f1
```

Paste the resulting SHA into the `sha256` field of the formula. Commit
and push the tap repo.

## Verification

```sh
# Add the tap, then install
brew tap artagon/tap
brew install artagon/tap/artagon-agent-cli-plugin

# Verify
artagon-agent --version
artagon-agent --help
artagon-openai-server --help
```

## Version bumps

Each new release of the npm package needs a corresponding tap update:

```sh
# 1. Tag + push (triggers npm-publish workflow)
cd /path/to/artagon-agent-cli-plugin
git tag -s v1.0.2 -m "release notes"
git push --tags

# 2. Wait for the npm publish workflow to complete:
gh workflow run npm-publish.yml -R artagon/artagon-agent-cli-plugin

# 3. Compute new SHA256
NEW_VER=1.0.2
NEW_SHA=$(curl -sL "https://registry.npmjs.org/artagon-agent-cli-plugin/-/artagon-agent-cli-plugin-${NEW_VER}.tgz" \
  | shasum -a 256 | cut -d' ' -f1)
echo "$NEW_SHA"

# 4. Update the tap formula
cd /path/to/homebrew-tap
sed -i.bak "s/${OLD_VER}/${NEW_VER}/g" Formula/artagon-agent-cli-plugin.rb
sed -i.bak "s/REPLACE_WITH_SHA256_OF_TARBALL\\|[a-f0-9]\\{64\\}/${NEW_SHA}/" Formula/artagon-agent-cli-plugin.rb

# 5. Commit + push the tap
git add Formula/artagon-agent-cli-plugin.rb
git commit -m "Update to v${NEW_VER}"
git push
```

Or automate steps 3–5 via a tap-side GitHub Actions workflow that
listens for npm publish events on the main repo. Pattern:

```yaml
# In artagon/homebrew-tap/.github/workflows/bump.yml
on:
  repository_dispatch:
    types: [npm-published]
jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Compute SHA256
        run: |
          VER=${{ github.event.client_payload.version }}
          SHA=$(curl -sL "https://registry.npmjs.org/artagon-agent-cli-plugin/-/artagon-agent-cli-plugin-${VER}.tgz" \
            | shasum -a 256 | cut -d' ' -f1)
          echo "VER=${VER}" >> $GITHUB_ENV
          echo "SHA=${SHA}" >> $GITHUB_ENV
      - name: Update formula
        run: |
          # ... sed commands to update Formula/artagon-agent-cli-plugin.rb ...
      - name: Commit + push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add Formula/
          git commit -m "Bump to v${VER}"
          git push
```

The main repo's npm-publish workflow would dispatch the event:

```yaml
- name: Notify tap
  uses: peter-evans/repository-dispatch@v3
  with:
    token: ${{ secrets.TAP_DISPATCH_TOKEN }}
    repository: artagon/homebrew-tap
    event-type: npm-published
    client-payload: '{"version": "${{ github.ref_name }}"}'
```

(Add `peter-evans/repository-dispatch@v3` step at the end of
`npm-publish.yml`.)

## Why a tap (and not homebrew-core)?

Homebrew's main core repo (`Homebrew/homebrew-core`) requires:

- ≥ 75 stars on the upstream repo
- ≥ 30 forks
- Stable >= 1y release history
- Notability bar (popular software, real-world demand)

Until those criteria are met, a personal/org tap is the right
distribution channel. Once met, the formula can be moved to
homebrew-core via the standard PR process.

## See also

- [Homebrew tap docs](https://docs.brew.sh/Taps)
- [Homebrew formula cookbook](https://docs.brew.sh/Formula-Cookbook)
- [Homebrew Node language helpers](https://rubydoc.brew.sh/Language/Node)
- `.github/workflows/npm-publish.yml` — the upstream publish workflow
- `README.md` — install paths including the brew one
