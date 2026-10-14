#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';

async function fetchPyPiNewPackages() {
  const records = [];
  const rssUrl = 'https://pypi.org/rss/packages.xml';

  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'ContextArmor-ProspectiveCollector/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[PyPI Feed] HTTP ${res.status}: ${res.statusText}`);
      return records;
    }

    const xml = await res.text();
    const itemRegex = /<item>[\s\S]*?<\/item>/g;
    const items = xml.match(itemRegex) || [];

    for (const item of items) {
      const titleMatch = item.match(/<title>(.*?) added to PyPI<\/title>/);
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const descMatch = item.match(/<description>(.*?)<\/description>/);

      const name = titleMatch ? titleMatch[1].trim() : undefined;
      const pubDate = pubDateMatch ? pubDateMatch[1].trim() : undefined;
      const description = descMatch ? descMatch[1].trim() : undefined;

      if (!name) continue;

      let initialMeta = {
        description,
        raw_feed_pubdate: pubDate,
      };

      try {
        const metaRes = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
          signal: AbortSignal.timeout(5000),
        });
        if (metaRes.ok) {
          const data = await metaRes.json();
          const info = data.info || {};
          const releases = data.releases || {};
          const releaseKeys = Object.keys(releases);
          const latestVer = info.version;

          let created = undefined;
          for (const k of releaseKeys) {
            for (const f of releases[k] || []) {
              if (f.upload_time_iso_8601) {
                if (!created || f.upload_time_iso_8601 < created) {
                  created = f.upload_time_iso_8601;
                }
              }
            }
          }

          initialMeta = {
            version: latestVer,
            description: info.summary || description,
            created_at: created || pubDate,
            author: info.author || info.maintainer,
            repository: info.project_urls?.Source || info.project_urls?.Repository || info.home_page,
            releases_count: releaseKeys.length,
            raw_feed_pubdate: pubDate,
          };
        }
      } catch (err) {
        // Fallback to feed-level info
      }

      records.push({
        name,
        ecosystem: 'pypi',
        first_seen: new Date().toISOString(),
        source_feed: 'https://pypi.org/rss/packages.xml',
        initial_metadata: initialMeta,
      });
    }
  } catch (err) {
    console.error(`[PyPI Feed Error]:`, err.message);
  }

  return records;
}

async function fetchNpmNewPackages() {
  const records = [];
  const feedUrl = 'https://replicate.npmjs.com/_changes?descending=true&limit=30';

  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': 'ContextArmor-ProspectiveCollector/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[npm Feed] HTTP ${res.status}: ${res.statusText}`);
      return records;
    }

    const data = await res.json();
    const results = data.results || [];

    for (const r of results) {
      const name = r.id;
      if (!name || name.startsWith('_design/')) continue;

      try {
        const metaRes = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (metaRes.ok) {
          const pkgData = await metaRes.json();
          const times = pkgData.time || {};
          const latestVer = pkgData['dist-tags']?.latest;
          const versions = Object.keys(pkgData.versions || {});

          const checkVer = latestVer || versions[versions.length - 1];
          let hasScripts = false;
          if (checkVer && pkgData.versions?.[checkVer]) {
            const scripts = pkgData.versions[checkVer].scripts || {};
            hasScripts = Boolean(scripts.preinstall || scripts.install || scripts.postinstall);
          }

          const repoUrl = typeof pkgData.repository === 'string'
            ? pkgData.repository
            : pkgData.repository?.url;

          records.push({
            name,
            ecosystem: 'npm',
            first_seen: new Date().toISOString(),
            source_feed: 'https://replicate.npmjs.com/_changes',
            initial_metadata: {
              version: checkVer,
              description: pkgData.description,
              created_at: times.created,
              author: typeof pkgData.author === 'string' ? pkgData.author : pkgData.author?.name,
              has_install_scripts: hasScripts,
              repository: repoUrl,
              releases_count: versions.length,
            },
          });
        }
      } catch (err) {
        // Non-fatal
      }
    }
  } catch (err) {
    console.error(`[npm Feed Error]:`, err.message);
  }

  return records;
}

async function main() {
  console.log('=== ContextArmor Prospective Collector ===');
  console.log(`Polling new package feeds at: ${new Date().toISOString()}`);

  const [pypiRecords, npmRecords] = await Promise.all([
    fetchPyPiNewPackages(),
    fetchNpmNewPackages(),
  ]);

  console.log(`Discovered ${pypiRecords.length} PyPI packages and ${npmRecords.length} npm packages from feeds.`);

  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), 'data/prospective');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${dateStr}.json`);

  let existing = [];
  if (fs.existsSync(outFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch {}
  }

  const existingMap = new Map();
  for (const item of existing) {
    existingMap.set(`${item.ecosystem}:${item.name}`, item);
  }

  for (const item of [...pypiRecords, ...npmRecords]) {
    if (!existingMap.has(`${item.ecosystem}:${item.name}`)) {
      existingMap.set(`${item.ecosystem}:${item.name}`, item);
    }
  }

  const merged = Array.from(existingMap.values());
  const MS_IN_24H = 24 * 60 * 60 * 1000;
  let keptCount = 0;
  let droppedCount = 0;

  const filtered = [];
  for (const item of merged) {
    const firstSeen = new Date(item.first_seen).getTime();
    const created = item.initial_metadata?.created_at ? new Date(item.initial_metadata.created_at).getTime() : null;
    const isFresh = created && (firstSeen - created) < MS_IN_24H && (firstSeen - created) >= 0;
    if (isFresh) {
      filtered.push(item);
      keptCount++;
    } else {
      droppedCount++;
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(filtered, null, 2), 'utf8');

  console.log(`Prospective filtering (created_at < 24h before first_seen):`);
  console.log(`  Kept:    ${keptCount}`);
  console.log(`  Dropped: ${droppedCount}`);
  console.log(`Snapshotted ${filtered.length} total fresh prospective packages for ${dateStr} into:`);
  console.log(`  ${outFile}`);
}

main().catch((err) => {
  console.error('Collector failed:', err);
  process.exit(1);
});
