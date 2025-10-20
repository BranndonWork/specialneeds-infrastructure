import json
import requests
import dotenv
import os

dotenv.load_dotenv()

endpoint = "https://r2.specialneeds.com/public/hello-world"
AUTH_HEADER_KEY = os.getenv("CLOUDFLARE_WORKER__AUTH_HEADER_KEY")
AUTH_KEY_SECRET = os.getenv("CLOUDFLARE_WORKER__AUTH_KEY_SECRET")
auto_expires = {}
auto_expires = {"x-amz-expiration": "10"}
headers = {AUTH_HEADER_KEY: AUTH_KEY_SECRET, **auto_expires}

data = "Hello World!"
data = json.dumps({"message": "Hello World!"})

data = {"message": "Hello World!"}

print("Sending PUT request to r2", endpoint)
response = requests.put(endpoint, headers=headers, json=data)

print(response.status_code)
print(response.text)
