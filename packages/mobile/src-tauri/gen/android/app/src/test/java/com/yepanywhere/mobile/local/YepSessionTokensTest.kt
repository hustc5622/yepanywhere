package com.yepanywhere.mobile.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class YepSessionTokensTest {
  @Test
  fun originsMatchTheWebOriginOfApiUrls() {
    assertEquals(
      "http://39.106.189.88:18022",
      YepSessionTokens.originOf("http://39.106.189.88:18022/yep/api/inbox"),
    )
    assertEquals(
      "http://39.106.189.88:18022",
      YepSessionTokens.originOf("http://39.106.189.88:18022"),
    )
    assertEquals(
      "https://air.yueyuan.uk",
      YepSessionTokens.originOf("https://AIR.yueyuan.uk/yep/api/x?y=1"),
    )
    assertNull(YepSessionTokens.originOf("tauri://localhost"))
    assertNull(YepSessionTokens.originOf("not a url"))
  }

  @Test
  fun authorizationHeaderOnlyWithToken() {
    assertEquals("Bearer t0k", YepSessionTokens.authorizationHeader(" t0k "))
    assertNull(YepSessionTokens.authorizationHeader(""))
    assertNull(YepSessionTokens.authorizationHeader(null))
  }
}
