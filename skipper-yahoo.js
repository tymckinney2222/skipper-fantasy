/* ============================================================================
 *  skipper-yahoo.js
 *  ----------------------------------------------------------------------------
 *  Yahoo Fantasy integration for Skipper. Extracted and refined from
 *  GameDay Vintage's production-tested Yahoo code.
 *
 *  What this module does:
 *    - Handles the OAuth token lifecycle (capture from URL on redirect,
 *      store in localStorage, refresh when expired)
 *    - Wraps the /api/* passthrough on the skipper-yahoo-auth worker
 *    - Returns clean, structured objects for Skipper's UI — no DOM rendering
 *      lives here. The caller decides how to display things.
 *
 *  What this module does NOT do:
 *    - No UI. Everything returns plain objects or throws errors.
 *    - No persistent storage beyond token caching. League data is ephemeral.
 *    - No Sleeper, Fantrax, or other platforms. That's a separate module.
 *
 *  Usage (from index.html):
 *
 *    import { SkipperYahoo } from './skipper-yahoo.js';
 *    const yahoo = new SkipperYahoo();
 *
 *    // On page load, check if we're returning from OAuth:
 *    yahoo.captureTokensFromUrl();  // no-op if not present
 *
 *    if (yahoo.isConnected()) {
 *      const leagues = await yahoo.getLeagues();    // [{ league_key, name, sport, ... }]
 *      const matchup = await yahoo.getMatchup(leagueKey);   // structured matchup
 *      const standings = await yahoo.getStandings(leagueKey);
 *      const roster = await yahoo.getRoster(leagueKey);
 *    } else {
 *      // Kick off OAuth
 *      window.location.href = yahoo.authUrl();
 *    }
 *
 *  Based on GameDay's code lines 16970–18072. That code powers the live
 *  league list, matchup, standings, and roster screens in GameDay today.
 * ==========================================================================*/

const WORKER_BASE = 'https://skipper-yahoo-auth.tymckinney2222.workers.dev';
const STORAGE_KEY = 'skipper_yahoo_tokens';
const CACHE_TTL_MS = 60 * 1000;          // 1 minute — matches GameDay's cache window
const REQUEST_TIMEOUT_MS = 15 * 1000;

/* Yahoo stat IDs for the common 5x5 cats. GameDay hardcodes these because
 * Yahoo assigns the same IDs across all leagues for a given sport, and
 * the /league/{key}/settings fetch is only needed when a league uses
 * non-standard categories. We'll still hit settings for cat leagues to
 * map custom stat IDs to names. */
const STAT_IDS = {
  nhl: [
    { id: '1',  label: 'G',    avg: false },
    { id: '2',  label: 'A',    avg: false },
    { id: '3',  label: 'PTS',  avg: false },
    { id: '4',  label: '+/-',  avg: false },
    { id: '8',  label: 'PPP',  avg: false },
    { id: '22', label: 'SOG',  avg: false },
  ],
  nba: [
    { id: '12', label: 'PTS',  avg: true },
    { id: '15', label: 'REB',  avg: true },
    { id: '16', label: 'AST',  avg: true },
    { id: '17', label: 'STL',  avg: true },
    { id: '19', label: 'BLK',  avg: true },
    { id: '5',  label: 'FG%',  avg: true, pct: true },
  ],
  mlb_batter: [
    { id: '60', label: 'AVG',  avg3: true },
    { id: '7',  label: 'HR' },
    { id: '13', label: 'RBI' },
    { id: '10', label: 'R' },
    { id: '16', label: 'SB' },
  ],
  mlb_pitcher: [
    { id: '50', label: 'ERA',  dec2: true },
    { id: '28', label: 'W' },
    { id: '42', label: 'K' },
    { id: '59', label: 'WHIP', dec2: true },
    { id: '57', label: 'SV' },
  ],
};

/* ============================================================================
 *  Helpers for walking Yahoo's auto-XML-to-JSON output.
 *
 *  Yahoo's JSON responses are notoriously ugly — nested objects with
 *  numeric string keys, `count` fields instead of arrays, and properties
 *  scattered across multiple array slots for the same entity.
 *
 *  `walkYahooArray` handles the common pattern where an entity's data is
 *  split across an array of objects. Example player_row:
 *    [
 *      { player_key: '458.p.6619' },
 *      { player_id: '6619' },
 *      { name: { full: 'Mike Trout', first: 'Mike', last: 'Trout' } },
 *      ...
 *    ]
 *  `walkYahooArray(playerRow, ['player_key', 'name.full'])` returns
 *    { player_key: '458.p.6619', name_full: 'Mike Trout' }
 * ==========================================================================*/
function walkYahooArray(arr, pathList) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    for (const path of pathList) {
      const parts = path.split('.');
      let val = item;
      for (const p of parts) {
        if (val == null) break;
        val = val[p];
      }
      if (val !== undefined && val !== null) {
        const key = path.replace(/\./g, '_');
        if (out[key] === undefined) out[key] = val;
      }
    }
  }
  return out;
}

/* Recursively find a value by key anywhere in an object — useful for
 * pulling deeply-nested values without knowing the exact path. */
function deepGet(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const k in obj) {
    const found = deepGet(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* Format a player's stat line from a stat_id → value map. */
function buildStatLine(playerStatsMap, sport, isPitcher) {
  if (!playerStatsMap) return '';
  const cfg = sport === 'mlb'
    ? (isPitcher ? STAT_IDS.mlb_pitcher : STAT_IDS.mlb_batter)
    : STAT_IDS[sport];
  if (!cfg) return '';

  const parts = [];
  for (const s of cfg) {
    const val = playerStatsMap[s.id];
    if (val === undefined || val === null || val === '-' || val === '') continue;
    const f = parseFloat(val);
    if (isNaN(f) || f === 0) continue;

    let display;
    if (s.pct)       display = (f * 100).toFixed(1) + '%';
    else if (s.avg3) display = f.toFixed(3).replace(/^0\./, '.');
    else if (s.dec2) display = f.toFixed(2);
    else if (s.avg)  display = f.toFixed(1);
    else             display = f % 1 === 0 ? String(parseInt(f)) : f.toFixed(1);

    parts.push(`${s.label} ${display}`);
  }
  return parts.join(' · ');
}

/* ============================================================================
 *  SkipperYahoo — main class
 * ==========================================================================*/
export class SkipperYahoo {
  constructor(options = {}) {
    this.workerBase = options.workerBase || WORKER_BASE;
    this.tokens = null;
    this.cache = new Map();            // path → { t: timestamp, d: data }

    // Attempt to restore tokens from localStorage on construction
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.tokens = JSON.parse(saved);
    } catch (e) { /* ignored */ }
  }

  /* --------------------------------------------------------------------
   *  OAuth lifecycle
   * ------------------------------------------------------------------*/

  /** URL to redirect to when the user taps "Connect with Yahoo". */
  authUrl() {
    return `${this.workerBase}/auth`;
  }

  /** Call on page load. If the URL contains ?yahoo_tokens=... captures
   *  them, stashes in localStorage, and cleans the URL. Returns true
   *  if tokens were captured (caller can refresh UI / load leagues). */
  captureTokensFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const tokensParam = urlParams.get('yahoo_tokens');
    if (!tokensParam) return false;

    try {
      const parsed = JSON.parse(decodeURIComponent(tokensParam));
      this.tokens = parsed;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      // Strip tokens from URL so they don't live in browser history
      history.replaceState({}, document.title, window.location.pathname);
      return true;
    } catch (e) {
      console.warn('[SkipperYahoo] Failed to parse yahoo_tokens URL param', e);
      return false;
    }
  }

  /** Is the user connected (have tokens, possibly stale)? */
  isConnected() {
    return this.tokens != null && this.tokens.access_token != null;
  }

  /** Disconnect: clear tokens, clear cache. Caller handles UI updates. */
  disconnect() {
    this.tokens = null;
    this.cache.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignored */ }
  }

  /** Get a fresh access token — refreshes if expired. Returns null if
   *  tokens are missing or refresh failed (user needs to reconnect). */
  async getAccessToken() {
    if (!this.tokens) return null;

    const now = Date.now();
    const expiresAt = (this.tokens.token_time || 0) + ((this.tokens.expires_in || 0) * 1000);
    const bufferMs = 60 * 1000;  // refresh if less than 1 minute left

    if (now < expiresAt - bufferMs) {
      return this.tokens.access_token;
    }

    // Expired — refresh
    if (!this.tokens.refresh_token) {
      this.disconnect();
      return null;
    }

    try {
      const res = await fetch(`${this.workerBase}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.tokens.refresh_token }),
      });
      if (!res.ok) {
        this.disconnect();
        return null;
      }
      const fresh = await res.json();
      this.tokens = fresh;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      return fresh.access_token;
    } catch (e) {
      console.warn('[SkipperYahoo] Refresh failed', e);
      this.disconnect();
      return null;
    }
  }

  /* --------------------------------------------------------------------
   *  Low-level API wrapper
   * ------------------------------------------------------------------*/

  /** Generic authenticated fetch to the Yahoo Fantasy API via our worker.
   *  Caches responses for CACHE_TTL_MS. Throws on failure. */
  async apiFetch(path) {
    const cached = this.cache.get(path);
    if (cached && cached.t > Date.now() - CACHE_TTL_MS) return cached.d;

    const token = await this.getAccessToken();
    if (!token) throw new Error('NOT_AUTHENTICATED');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.workerBase}/api${path}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 401) {
        this.disconnect();
        throw new Error('NOT_AUTHENTICATED');
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

      const data = JSON.parse(text);
      this.cache.set(path, { t: Date.now(), d: data });
      return data;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new Error('REQUEST_TIMEOUT');
      throw e;
    }
  }

  /** Clear the per-path response cache — call after user taps refresh. */
  clearCache() { this.cache.clear(); }

  /* --------------------------------------------------------------------
   *  High-level: leagues, matchups, standings, roster
   * ------------------------------------------------------------------*/

  /** Get all leagues the user is in, across every sport Yahoo knows about.
   *  Returns: [{ league_key, name, sport, season, num_teams, scoring_type, ... }]
   *  scoring_type is 'head' | 'headpoint' | 'roto' | 'points' from Yahoo. */
  async getLeagues() {
    const data = await this.apiFetch('/users;use_login=1/games;is_available=1/leagues');
    const leagues = [];

    try {
      const games = data.fantasy_content.users[0].user[1].games;
      const gameCount = games.count;

      for (let i = 0; i < gameCount; i++) {
        const game = games[i].game;
        const meta = game[0];
        const leaguesObj = game[1] && game[1].leagues;
        if (!leaguesObj) continue;

        for (let j = 0; j < leaguesObj.count; j++) {
          const lg = leaguesObj[j].league[0];
          leagues.push({
            league_key: lg.league_key,
            league_id: lg.league_id,
            name: lg.name,
            sport: meta.code,         // 'mlb', 'nfl', 'nba', 'nhl'
            season: meta.season,
            num_teams: Number(lg.num_teams),
            scoring_type: lg.scoring_type || 'unknown',
            url: lg.url,
            current_week: lg.current_week,
            start_week: lg.start_week,
            end_week: lg.end_week,
            // Derived: is this a category/roto league?
            is_cats: this._isCategoryScoring(lg.scoring_type),
          });
        }
      }
    } catch (e) {
      throw new Error(`Failed to parse leagues: ${e.message}`);
    }

    return leagues;
  }

  /** Normalize Yahoo's scoring_type field into a boolean "is this cat-based?" */
  _isCategoryScoring(scoringType) {
    if (!scoringType) return false;
    const st = String(scoringType).toLowerCase();
    return st === 'head' || st === 'headone' || st === 'categories' || st === 'roto';
  }

  /** Normalize scoring_type to Skipper's canonical enum: 'points' | 'cats' | 'roto' */
  static normalizeScoring(scoringType) {
    if (!scoringType) return 'points';
    const st = String(scoringType).toLowerCase();
    if (st === 'roto') return 'roto';
    if (st === 'head' || st === 'headone' || st === 'categories') return 'cats';
    return 'points';
  }

  /** Get the current week's matchups for a league.
   *  Returns: {
   *    league_key, scoring_type, current_week,
   *    matchups: [{
   *      week, is_tied,
   *      sides: [
   *        { team_key, name, points, projected_points, is_mine, team_logo, team_record },
   *        { ... }
   *      ]
   *    }]
   *  } */
  async getMatchups(leagueKey) {
    const data = await this.apiFetch(`/league/${leagueKey}/scoreboard`);

    try {
      const leagueMeta = data.fantasy_content.league[0];
      let scoringType = '';
      if (Array.isArray(leagueMeta)) {
        for (const x of leagueMeta) {
          if (x && x.scoring_type) scoringType = x.scoring_type;
        }
      } else if (leagueMeta && leagueMeta.scoring_type) {
        scoringType = leagueMeta.scoring_type;
      }

      const sb = data.fantasy_content.league[1].scoreboard;
      const matchupsObj = sb['0'].matchups;
      const currentWeek = matchupsObj['0']?.matchup?.week || null;
      const count = matchupsObj.count;

      const matchups = [];
      for (let i = 0; i < count; i++) {
        const matchup = matchupsObj[i].matchup;
        const teams = matchup['0'].teams;

        const sides = [teams['0'].team, teams['1'].team].map((team) => {
          const info = walkYahooArray(team[0], [
            'team_key', 'team_id', 'name', 'is_owned_by_current_login',
            'team_logos',
          ]);
          const stats = team[1] || {};
          let logo = null;
          if (info.team_logos && Array.isArray(info.team_logos)) {
            const first = info.team_logos[0];
            if (first && first.team_logo) logo = first.team_logo.url;
          }
          return {
            team_key: info.team_key,
            team_id: info.team_id,
            name: info.name,
            is_mine: info.is_owned_by_current_login == 1,
            team_logo: logo,
            points: stats.team_points?.total != null
              ? parseFloat(stats.team_points.total) : null,
            projected_points: stats.team_projected_points?.total != null
              ? parseFloat(stats.team_projected_points.total) : null,
          };
        });

        matchups.push({
          week: currentWeek,
          is_tied: matchup.is_tied == 1,
          status: matchup.status,         // 'preevent' | 'midevent' | 'postevent'
          sides,
        });
      }

      return {
        league_key: leagueKey,
        scoring_type: scoringType,
        scoring_normalized: SkipperYahoo.normalizeScoring(scoringType),
        current_week: currentWeek,
        matchups,
      };
    } catch (e) {
      throw new Error(`Failed to parse matchups: ${e.message}`);
    }
  }

  /** Get the category breakdown for a single matchup in a cat league.
   *  Requires: the two team_keys from that matchup (from getMatchups).
   *  Returns: {
   *    week, stats: [{ stat_id, name, display_name, value_a, value_b,
   *                    winner: 'a' | 'b' | 'tie', is_tied }],
   *    summary: { wins_a, wins_b, ties }
   *  } */
  async getCategoryBreakdown(leagueKey, teamKeyA, teamKeyB, week) {
    // Fetch stat categories to build ID → name map
    const statIdToName = await this._getStatCategoryMap(leagueKey);

    const weekParam = week ? `;week=${week}` : '';
    const data = await this.apiFetch(
      `/league/${leagueKey}/scoreboard;out=matchups${weekParam}`
    );

    try {
      const matchupsObj = data.fantasy_content.league[1].scoreboard['0'].matchups;

      // Locate the matchup containing both our team keys
      let matchupObj = null;
      for (let i = 0; i < matchupsObj.count; i++) {
        const m = matchupsObj[i].matchup;
        const mTeams = m['0'].teams;
        let mk0 = '', mk1 = '';
        const team0 = walkYahooArray(mTeams['0'].team[0], ['team_key']);
        const team1 = walkYahooArray(mTeams['1'].team[0], ['team_key']);
        mk0 = team0.team_key;
        mk1 = team1.team_key;

        if ((mk0 === teamKeyA && mk1 === teamKeyB) ||
            (mk0 === teamKeyB && mk1 === teamKeyA)) {
          matchupObj = m;
          break;
        }
      }
      if (!matchupObj) throw new Error('Matchup not found for the given team keys');

      // Collect team stat totals
      const teams = matchupObj['0'].teams;
      const teamStats = [[], []];
      const teamKeys = [];
      [teams['0'].team, teams['1'].team].forEach((t, ti) => {
        const info = walkYahooArray(t[0], ['team_key']);
        teamKeys.push(info.team_key);
        if (t[1] && t[1].team_stats && t[1].team_stats.stats) {
          for (const s of t[1].team_stats.stats) {
            if (s && s.stat) teamStats[ti][s.stat.stat_id] = s.stat.value;
          }
        }
      });

      // Normalize which side is A vs B based on requested order
      const aIdx = teamKeys[0] === teamKeyA ? 0 : 1;
      const bIdx = 1 - aIdx;

      const stats = [];
      let wins_a = 0, wins_b = 0, ties = 0;

      if (matchupObj.stat_winners) {
        const sw = matchupObj.stat_winners;
        const count = sw.count || Object.keys(sw).filter(k => !isNaN(k)).length;

        for (let i = 0; i < count; i++) {
          const entry = sw[i] && sw[i].stat_winner;
          if (!entry) continue;

          const statId = entry.stat_id;
          const winnerKey = entry.winner_team_key;
          const isTied = entry.is_tied == 1;
          const nameEntry = statIdToName[statId] || { name: statId, display_name: statId };

          const value_a = teamStats[aIdx][statId] ?? null;
          const value_b = teamStats[bIdx][statId] ?? null;

          let winner = 'tie';
          if (!isTied) {
            if (winnerKey === teamKeyA) { winner = 'a'; wins_a++; }
            else if (winnerKey === teamKeyB) { winner = 'b'; wins_b++; }
            else { winner = 'tie'; ties++; }
          } else {
            ties++;
          }

          stats.push({
            stat_id: statId,
            name: nameEntry.name,
            display_name: nameEntry.display_name,
            value_a,
            value_b,
            winner,
            is_tied: isTied,
          });
        }
      }

      return {
        week,
        stats,
        summary: { wins_a, wins_b, ties },
      };
    } catch (e) {
      throw new Error(`Failed to parse category breakdown: ${e.message}`);
    }
  }

  /** Internal: fetch league settings and build a stat_id → {name, display_name} map. */
  async _getStatCategoryMap(leagueKey) {
    const data = await this.apiFetch(`/league/${leagueKey}/settings`);
    const map = {};
    try {
      const stats = data.fantasy_content.league[1].settings.stat_categories.stats;
      for (const s of stats) {
        if (s && s.stat) {
          map[s.stat.stat_id] = {
            name: s.stat.name || s.stat.display_name || s.stat.stat_id,
            display_name: s.stat.display_name || s.stat.name || s.stat.stat_id,
            position_type: s.stat.position_type, // 'B' batter, 'P' pitcher
          };
        }
      }
    } catch (e) { /* return empty map */ }
    return map;
  }

  /** Get league standings.
   *  Returns: [{
   *    team_key, name, is_mine, rank,
   *    wins, losses, ties, pct, games_back,
   *    points_for, points_against, streak,
   *    team_logo
   *  }]
   *  For roto leagues, `rank` and `points_for` represent the roto rank and
   *  roto points. For H2H, it's W/L standings. */
  async getStandings(leagueKey) {
    const data = await this.apiFetch(`/league/${leagueKey}/standings`);

    try {
      const teams = data.fantasy_content.league[1].standings[0].teams;
      const count = teams.count;
      const rows = [];

      for (let i = 0; i < count; i++) {
        const arr = teams[i].team[0];
        const standings = teams[i].team[2] && teams[i].team[2].team_standings;

        const info = walkYahooArray(arr, [
          'team_key', 'name', 'is_owned_by_current_login', 'team_logos',
        ]);

        let logo = null;
        if (info.team_logos && Array.isArray(info.team_logos)) {
          const first = info.team_logos[0];
          if (first && first.team_logo) logo = first.team_logo.url;
        }

        const row = {
          team_key: info.team_key,
          name: info.name,
          is_mine: info.is_owned_by_current_login == 1,
          team_logo: logo,
          rank: standings?.rank ? Number(standings.rank) : (i + 1),
          wins: standings?.outcome_totals?.wins ?? null,
          losses: standings?.outcome_totals?.losses ?? null,
          ties: standings?.outcome_totals?.ties ?? null,
          pct: standings?.outcome_totals?.percentage ?? null,
          games_back: standings?.games_back ?? null,
          points_for: standings?.points_for != null
            ? parseFloat(standings.points_for) : null,
          points_against: standings?.points_against != null
            ? parseFloat(standings.points_against) : null,
          streak: standings?.streak?.value
            ? `${standings.streak.type === 'win' ? 'W' : 'L'}${standings.streak.value}`
            : null,
        };
        rows.push(row);
      }

      return rows;
    } catch (e) {
      throw new Error(`Failed to parse standings: ${e.message}`);
    }
  }

  /** Get the current user's roster in a league.
   *  Returns: [{
   *    player_key, name, team_abbr, positions_eligible,
   *    selected_position, is_bench, is_injured,
   *    status,          // 'DTD' | 'IL' | 'O' | etc
   *    headshot_url
   *  }]
   *  NOTE: does NOT include stats — call getPlayerStats separately for that. */
  async getRoster(leagueKey) {
    const data = await this.apiFetch(
      `/league/${leagueKey}/teams;is_owned_by_current_login=1/roster`
    );

    try {
      const teamsData = data.fantasy_content.league[1].teams;
      if (!teamsData || teamsData.count === 0) return [];

      // Find my team (even though we filtered, Yahoo sometimes returns extras)
      let myTeamIdx = 0;
      for (let ti = 0; ti < teamsData.count; ti++) {
        const tArr = teamsData[ti]?.team?.[0];
        if (Array.isArray(tArr)) {
          for (const x of tArr) {
            if (x && x.is_owned_by_current_login == 1) { myTeamIdx = ti; break; }
          }
        }
      }

      const myTeamData = teamsData[myTeamIdx]?.team;
      if (!myTeamData) throw new Error('No team data found');

      // Roster shape can vary — check both known paths
      const rosterRoot = myTeamData[1] && myTeamData[1].roster;
      if (!rosterRoot) throw new Error('No roster found');

      const players = rosterRoot['0']?.players || rosterRoot.players;
      if (!players) return [];

      const count = players.count || 0;
      const rows = [];

      for (let i = 0; i < count; i++) {
        try {
          const playerRaw = players[i].player;
          const pArr = Array.isArray(playerRaw[0]) ? playerRaw[0] : [];
          const selPosData = playerRaw[1] ? playerRaw[1].selected_position : null;
          const selectedPosition = selPosData ? selPosData[1]?.position : '';

          // Walk the scattered player attributes
          let name = '', teamAbbr = '', displayPosition = '', status = '';
          let playerKey = '', eligible = [], headshot = '';
          for (const x of pArr) {
            if (!x || typeof x !== 'object') continue;
            if (x.name) {
              if (typeof x.name === 'object' && x.name.full) name = x.name.full;
              else if (typeof x.name === 'string') name = x.name;
            }
            if (x.editorial_team_abbr) teamAbbr = x.editorial_team_abbr.toUpperCase();
            if (x.display_position) displayPosition = x.display_position;
            if (x.status) status = x.status;
            if (x.player_key) playerKey = x.player_key;
            if (x.eligible_positions && Array.isArray(x.eligible_positions)) {
              eligible = x.eligible_positions.map(e => e.position).filter(Boolean);
            }
            if (x.headshot && x.headshot.url) headshot = x.headshot.url;
          }

          const benchPositions = new Set(['BN', 'IL', 'IL+', 'IR', 'NA']);

          rows.push({
            player_key: playerKey,
            name,
            team_abbr: teamAbbr,
            display_position: displayPosition,
            selected_position: selectedPosition,
            positions_eligible: eligible,
            is_bench: benchPositions.has(selectedPosition),
            is_injured: ['IL', 'IL+', 'IR', 'O', 'OUT'].includes(status.toUpperCase()),
            status,
            headshot_url: headshot,
          });
        } catch (e) {
          // Skip any malformed player entries rather than failing the whole roster
          console.warn('[SkipperYahoo] Skipped malformed player', e);
        }
      }

      return rows;
    } catch (e) {
      throw new Error(`Failed to parse roster: ${e.message}`);
    }
  }

  /** Get player stats for a set of player keys. Works for both points
   *  and cat leagues. Returns a map:
   *    { [player_key]: { [stat_id]: value, ...,
   *                      _statLine: 'HR 12 · RBI 38 · ...' } }
   *  `type` is Yahoo's stats type: 'season' (default), 'week', 'date',
   *  'average_season' (NBA), 'lastweek', 'lastmonth'. For per-date, pass
   *  `{ type: 'date', date: '2026-04-22' }`. For per-week, `{ type: 'week',
   *  week: 3 }`. */
  async getPlayerStats(leagueKey, playerKeys, options = {}) {
    if (!playerKeys || playerKeys.length === 0) return {};

    const sport = options.sport || 'mlb';
    const isPitcher = options.isPitcher || null;
    const type = options.type || 'season';
    const statsParam =
      type === 'week' && options.week     ? `;type=week;week=${options.week}` :
      type === 'date' && options.date     ? `;type=date;date=${options.date}` :
      type === 'average_season'           ? ';type=average_season' :
      type === 'lastweek'                 ? ';type=lastweek' :
      type === 'lastmonth'                ? ';type=lastmonth' :
                                            ';type=season';

    const statsMap = {};

    // Yahoo caps batch fetches around 25 players per call
    for (let chunk = 0; chunk < playerKeys.length; chunk += 25) {
      const batch = playerKeys.slice(chunk, chunk + 25).join(',');
      try {
        const data = await this.apiFetch(
          `/league/${leagueKey}/players;player_keys=${batch}/stats${statsParam}`
        );
        const pContent = data.fantasy_content.league[1].players;
        const count = pContent.count;

        for (let pi = 0; pi < count; pi++) {
          const pRaw = pContent[pi].player;
          let playerKey = '';
          if (Array.isArray(pRaw[0])) {
            for (const x of pRaw[0]) {
              if (x && x.player_key) playerKey = x.player_key;
            }
          }

          // The stats object may live at pRaw[1], pRaw[2], etc.
          let statsObj = null;
          for (let j = 0; j < pRaw.length; j++) {
            if (pRaw[j]?.player_stats?.stats) {
              statsObj = pRaw[j].player_stats.stats;
              break;
            }
          }
          if (!statsObj) continue;

          const playerStats = {};
          for (const s of statsObj) {
            if (s && s.stat) playerStats[s.stat.stat_id] = s.stat.value;
          }

          // Pre-compute a formatted stat line for convenience
          // (caller can ignore and format their own way)
          const pitcherGuess = isPitcher != null ? isPitcher : false;
          playerStats._statLine = buildStatLine(playerStats, sport, pitcherGuess);

          statsMap[playerKey] = playerStats;
        }
      } catch (e) {
        console.warn('[SkipperYahoo] Stats chunk failed', e);
      }
    }

    return statsMap;
  }
}

// Named export of utilities for callers who want to format stats themselves
export { buildStatLine, walkYahooArray, deepGet, STAT_IDS };
