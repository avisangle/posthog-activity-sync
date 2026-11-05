import {
  definePageLayoutWidget,
  PageLayoutTabLayoutMode,
  PageLayoutWidgetVerticalListHeightBehavior,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  STANDARD_PAGE_LAYOUT,
  WidgetType,
} from 'twenty-sdk/define';

import {
  PRODUCT_ACTIVITY_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  PRODUCT_ACTIVITY_WIDGET_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

// The Home tab is a vertical list; the standard fields widget sits at index 0.
export default definePageLayoutWidget({
  universalIdentifier: PRODUCT_ACTIVITY_WIDGET_UNIVERSAL_IDENTIFIER,
  pageLayoutTabUniversalIdentifier: STANDARD_PAGE_LAYOUT.personRecordPage.tabs.home.universalIdentifier,
  title: 'Product activity',
  type: WidgetType.FRONT_COMPONENT,
  objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  position: { layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST, index: 1 },
  heightBehavior: PageLayoutWidgetVerticalListHeightBehavior.FIT_CONTENT,
  configuration: {
    configurationType: 'FRONT_COMPONENT',
    frontComponentUniversalIdentifier: PRODUCT_ACTIVITY_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  },
});
