import sys
from PIL import Image, ImageDraw, ImageFont
text, out = sys.argv[1], sys.argv[2]
font = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 40)
pad_x, pad_y = 24, 16
img = Image.new("RGBA", (10, 10))
w, h = ImageDraw.Draw(img).textbbox((0, 0), text, font=font)[2:]
img = Image.new("RGBA", (w + 2*pad_x, h + 2*pad_y), (0, 0, 0, 150))
ImageDraw.Draw(img).text((pad_x, pad_y - 4), text, font=font, fill=(255, 255, 255, 240))
img.save(out)
print(out, img.size)
