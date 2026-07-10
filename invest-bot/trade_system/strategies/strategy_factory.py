from typing import Optional

from trade_system.strategies.oi_composite_strategy import OICompositeStrategy
from trade_system.strategies.hierarchical_strategy import HierarchicalStrategy
from trade_system.strategies.level_reaction_strategy import LevelReactionStrategy
from trade_system.strategies.base_strategy import IStrategy

__all__ = ("StrategyFactory")


class StrategyFactory:
    """
    Fabric for strategies. Put here new strategy.
    """
    @staticmethod
    def new_factory(strategy_name: str, *args, **kwargs) -> Optional[IStrategy]:
        match strategy_name:
            case "OICompositeStrategy":
                return OICompositeStrategy(*args, **kwargs)
            case "HierarchicalStrategy":
                return HierarchicalStrategy(*args, **kwargs)
            case "LevelReactionStrategy":
                return LevelReactionStrategy(*args, **kwargs)
            case _:
                return None
