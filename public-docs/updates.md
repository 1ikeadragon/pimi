---
title: Updates
description: How Pimi releases work, the difference between stable and beta channels, and how to opt in to earlier updates.
nav: Updates
order: 5
category: Getting started
---

# Updates

Pimi ships updates through two channels: **Stable** and **Beta**.

Most releases go out on the stable channel. Betas are release candidates that let you test what's coming next before it rolls out to everyone.

## Version numbers

Pimi follows [Semantic Versioning](https://semver.org) with prerelease tags.

A stable release looks like this:

```
v0.1.90
```

A beta for the same release looks like this:

```
v0.1.90-beta.1
```

If a release needs more testing, we cut additional betas:

```
v0.1.92-beta.1
v0.1.92-beta.2
v0.1.92-beta.3
```

When the release is ready, the final stable tag is `v0.1.92` — not `v0.1.93`. The betas are checkpoints on the way to the same stable version.

## Stable channel

The stable channel is the default. Stable desktop releases roll out gradually over **36 hours** so that if something unexpected slips through, it doesn't hit everyone at once. Automatic update checks pick up the release as the rollout progresses; clicking **Check** in the app bypasses the rollout and installs immediately.

Stable releases are what most users should run.

## Beta channel

The beta channel gets every prerelease as soon as it's published, with no rollout delay. When a beta is promoted to stable, beta users receive that stable update immediately too.

Betas are the best way to get fixes and features early. If you hit a bug, report it — beta feedback is what makes stable releases reliable.

### How to join the beta channel

The app has no channel switch. Install a beta build from the [GitHub releases page](https://github.com/1ikeadragon/pimi/releases), or set `releaseChannel` to `beta` in `desktop-settings.json` in the app's user data folder. The app checks for beta updates from then on.

## App stores

Desktop releases and the CLI are usually available first. App Store and Play Store releases can lag behind because they go through review.

There is no beta channel in the app stores right now — only stable builds are submitted. If you want early Android builds, download the APK from the [GitHub releases page](https://github.com/1ikeadragon/pimi/releases).

## What to do if something breaks

Beta builds are expected to have rough edges. If a beta causes problems, you can switch back by setting `releaseChannel` to `stable` in `desktop-settings.json`. The next stable update will install normally.

If you need a fix that hasn't shipped to stable yet, stay on beta and report the issue. Most problems found in beta are fixed before the stable release.
