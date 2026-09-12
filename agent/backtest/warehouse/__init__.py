"""Local market-data warehouse: layout, schema, store, sync, audit.

Opt-in (``VIBE_TRADING_WAREHOUSE_ENABLED``). Nothing in the online read path
touches these modules until a loader is registered, so an install without the
flag behaves exactly as before.
"""
