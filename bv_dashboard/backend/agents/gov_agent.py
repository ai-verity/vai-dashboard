"""
Government / law-enforcement agent (ported from tx-safety/agents/gov_agent.py).

Includes the official agency feeds tx-safety uses (TxDPS, TDEM, TxDOT, TX AG,
FBI field offices, US Marshals, DEA). Many of these sit behind CDN bot-walls
that 403 datacenter IPs or have moved their RSS, so a Google News agency
aggregator is included as a reliable fallback that is never blocked. Unreachable
feeds are skipped per-source (reported as -1 in /api/feeds/status).
"""
from __future__ import annotations

from agents.base import BaseAgent


class GovAgent(BaseAgent):
    name = "gov_agent"
    FEEDS = [
        # Reliable aggregator fallback for the bot-walled agency sites.
        ("Google News — Gov/Agencies",
         "https://news.google.com/rss/search?q=Texas%20(FBI%20OR%20DEA%20OR%20%22US%20Marshals%22%20"
         "OR%20DPS%20OR%20%22Border%20Patrol%22%20OR%20sheriff)%20(indicted%20OR%20sentenced%20OR%20"
         "arrested%20OR%20charged)%20when:7d&hl=en-US&gl=US&ceid=US:en", ""),
        # Official agency feeds (best-effort; frequently 403/404 from server IPs).
        ("TxDPS News", "https://www.dps.texas.gov/rss/vNewsRSS.cfm", ""),
        ("Texas DEM", "https://tdem.texas.gov/feed/", ""),
        ("TxDOT Newsroom", "https://www.txdot.gov/about/newsroom/news-releases.html.rss", ""),
        ("TX Attorney General", "https://www.texasattorneygeneral.gov/news/rss", ""),
        ("FBI Dallas", "https://www.fbi.gov/contact-us/field-offices/dallas/news/rss", "dallas"),
        ("FBI Houston", "https://www.fbi.gov/contact-us/field-offices/houston/news/rss", "houston"),
        ("FBI San Antonio", "https://www.fbi.gov/contact-us/field-offices/sanantonio/news/rss", "san antonio"),
        ("FBI El Paso", "https://www.fbi.gov/contact-us/field-offices/elpaso/news/rss", "el paso"),
        ("US Marshals", "https://www.usmarshals.gov/news/rss", ""),
        ("DEA Press", "https://www.dea.gov/press-releases/rss", ""),
    ]
