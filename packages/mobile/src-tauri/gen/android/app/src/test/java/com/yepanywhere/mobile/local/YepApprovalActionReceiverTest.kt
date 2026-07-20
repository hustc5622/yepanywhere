package com.yepanywhere.mobile.local

import java.net.HttpURLConnection
import java.net.URL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class YepApprovalActionReceiverTest {
  @Test
  fun approvalWritesIncludeRequiredCustomHeader() {
    val connection = RecordingHttpURLConnection()

    YepApprovalActionReceiver.configureApiRequest(
      connection,
      hasBody = true,
      cookie = "yep_session=test-session",
    )

    assertEquals("true", connection.getRequestProperty("X-Yep-Anywhere"))
    assertEquals("application/json", connection.getRequestProperty("Content-Type"))
    assertEquals("yep_session=test-session", connection.getRequestProperty("Cookie"))
    assertTrue(connection.doOutput)
  }

  private class RecordingHttpURLConnection :
    HttpURLConnection(URL("http://127.0.0.1/yep/api/sessions/test/input")) {
    override fun connect() = Unit

    override fun disconnect() = Unit

    override fun usingProxy(): Boolean = false
  }
}
