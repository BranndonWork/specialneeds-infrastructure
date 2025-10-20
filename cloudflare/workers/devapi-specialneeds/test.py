import os
import time
import dotenv
import CloudFlare


dotenv.load_dotenv()

# Cloudflare API details
CLOUDFLARE_EMAIL = os.environ.get("CLOUDFLARE_ACCOUNT_EMAIL")
CLOUDFLARE_API_KEY = os.environ.get("CLOUDFLARE_GLOBAL_API_KEY")
CLOUDFLARE_NAMESPACE_ID = os.environ.get("CLOUDFLARE_DEV_NAMESPACE_ID")
CLOUDFLARE_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")

cf = CloudFlare.CloudFlare(email=CLOUDFLARE_EMAIL, token=CLOUDFLARE_API_KEY)


class Cloudflare:
    def __init__(self):
        self.cf = CloudFlare.CloudFlare(email=CLOUDFLARE_EMAIL, token=CLOUDFLARE_API_KEY)
        self.namespace_id = CLOUDFLARE_NAMESPACE_ID
        self.account_id = CLOUDFLARE_ACCOUNT_ID

    def kv_put(self, key, value):
        self.cf.accounts.storage.kv.namespaces.values.put(self.account_id, self.namespace_id, key, data=value)

    def kv_get(self, key):
        try:
            return self.cf.accounts.storage.kv.namespaces.values.get(self.account_id, self.namespace_id, key)
        except CloudFlare.exceptions.CloudFlareAPIError as e:
            if str(e) == "get: 'key not found'":
                return None
            raise e


cloudflare = Cloudflare()

key = "old_url"
value = "new_redirect_url"

start_time = time.time()
cloudflare.kv_put(key, value)
print("PUT", time.time() - start_time)

start_time_2 = time.time()
result = cloudflare.kv_get(key)
print("GET 1", time.time() - start_time_2)
print(result)

start_time_3 = time.time()
try:
    result = cloudflare.kv_get(f"{key}-bad")
    print("GET 2", time.time() - start_time_3)
except CloudFlare.exceptions.CloudFlareAPIError as e:
    print("GET 3", time.time() - start_time_3)
    print(e)

print("Total time", time.time() - start_time)
