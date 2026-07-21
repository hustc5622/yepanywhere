package com.yepanywhere.mobile.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class YepNativeNotifierTest {
  @Test
  fun questionNotificationOnlyRoutesIntoYep() {
    assertEquals(
      "Question waiting — open Yep to answer",
      YepNativeNotifier.pendingInputBody(
        "user-question",
        "Sensitive question text should not be shown",
      ),
    )
    assertNull(
      YepNativeNotifier.pendingApprovalRequestId("user-question", "question-1"),
    )
  }

  @Test
  fun toolApprovalKeepsSummaryAndQuickAction() {
    assertEquals(
      "Approval needed · Edit: file.ts",
      YepNativeNotifier.pendingInputBody("tool-approval", "Edit: file.ts"),
    )
    assertEquals(
      "approval-1",
      YepNativeNotifier.pendingApprovalRequestId("tool-approval", "approval-1"),
    )
  }
}
