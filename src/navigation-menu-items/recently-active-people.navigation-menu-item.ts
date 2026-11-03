import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import {
  RECENTLY_ACTIVE_PEOPLE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: RECENTLY_ACTIVE_PEOPLE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Recently active people',
  icon: 'IconActivity',
  position: 0,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_UNIVERSAL_IDENTIFIER,
});
