package sh.pimi.pushpreview

import expo.modules.notifications.service.ExpoFirebaseMessagingService

/** FCM entry point. Runs ahead of expo-notifications' own service and hands every message to it. */
class PimiFirebaseMessagingService : ExpoFirebaseMessagingService()
