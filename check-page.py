import urllib.request
import sys

urls = [
    'http://127.0.0.1:8022/',
    'http://127.0.0.1:8022/assets/index-GzSqs9qQ.js',
    'http://127.0.0.1:8022/assets/index-WVHGNAr0.css',
    'http://127.0.0.1:8022/assets/vendor-react-CT-4HrYF.js',
    'http://127.0.0.1:8022/api/version',
    'http://127.0.0.1:8022/api/auth/status',
    'http://127.0.0.1:8022/api/onboarding',
]

for url in urls:
    try:
        req = urllib.request.Request(url, headers={'X-Yep-Anywhere': 'true'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            print(f'{url}: {resp.status} {resp.getheader("Content-Type")} {len(data)} bytes')
    except Exception as e:
        print(f'{url}: ERROR {e}')
