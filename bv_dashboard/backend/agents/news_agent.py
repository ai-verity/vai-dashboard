"""
News agent — Texas local news + public-safety RSS (ported from
tx-safety/agents/news_agent.py), plus a Google News safety aggregator.

Each feed carries a default city so headlines that don't name a location still
geocode to the outlet's market.
"""
from __future__ import annotations

from agents.base import BaseAgent


class NewsAgent(BaseAgent):
    name = "news_agent"
    FEEDS = [
        # ── Aggregator (reliable, statewide) ──
        ("Google News — Texas Safety",
         "https://news.google.com/rss/search?q=Texas%20(shooting%20OR%20crash%20OR%20"
         "fire%20OR%20stabbing%20OR%20robbery%20OR%20arrest%20OR%20flood%20OR%20police)%20"
         "when:3d&hl=en-US&gl=US&ceid=US:en", ""),
        # ── Houston ──
        ("Houston Public Media", "https://www.houstonpublicmedia.org/feed/", "houston"),
        ("KHOU Houston", "https://www.khou.com/feeds/rss/news/local/", "houston"),
        ("Click2Houston KPRC", "https://www.click2houston.com/rss/", "houston"),
        ("ABC13 Houston", "https://abc13.com/feed/", "houston"),
        # ── Dallas / Fort Worth ──
        ("WFAA Dallas", "https://www.wfaa.com/feeds/rss/news/local/", "dallas"),
        ("CBS DFW", "https://www.cbsnews.com/dallas/rss/", "dallas"),
        ("NBC5 Dallas", "https://www.nbcdfw.com/feed/", "dallas"),
        # ── San Antonio ──
        ("KSAT San Antonio", "https://www.ksat.com/rss", "san antonio"),
        ("MySA News", "https://www.mysanantonio.com/local/rss", "san antonio"),
        # ── Austin ──
        ("KXAN Austin", "https://www.kxan.com/feed/", "austin"),
        ("KVUE Austin", "https://www.kvue.com/feeds/rss/news/local/", "austin"),
        # ── Statewide ──
        ("Texas Tribune", "https://www.texastribune.org/feeds/all/", ""),
        # ── West Texas / Permian ──
        ("Odessa American", "https://www.oaoa.com/feed/", "odessa"),
        ("Midland Reporter-Telegram", "https://www.mrt.com/feed/", "midland"),
        ("KLBK Lubbock", "https://www.klbk13.com/feed/", "lubbock"),
        ("KAMR Amarillo", "https://www.myhighplains.com/feed/", ""),
        # ── East Texas / Other ──
        ("KETK Tyler", "https://www.ketk.com/feed/", "tyler"),
        ("Beaumont Enterprise", "https://www.beaumontenterprise.com/feed/", "beaumont"),
        # ── Rio Grande Valley ──
        ("ValleyCentral RGV", "https://www.valleycentral.com/news/local-news/feed/", "harlingen"),
        ("ValleyCentral Crime", "https://www.valleycentral.com/news/crime/feed/", "harlingen"),
    ]
