from html.parser import HTMLParser

class MyHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []
        
    def handle_starttag(self, tag, attrs):
        if tag in ['img', 'br', 'hr', 'input', 'meta', 'link']: return
        self.stack.append((tag, self.getpos()))
        
    def handle_endtag(self, tag):
        if tag in ['img', 'br', 'hr', 'input', 'meta', 'link']: return
        if not self.stack:
            self.errors.append(f"Unexpected end tag <{tag}> at {self.getpos()}")
            return
        expected_tag, pos = self.stack.pop()
        if expected_tag != tag:
            self.errors.append(f"Expected </{expected_tag}> (opened at {pos}), but got </{tag}> at {self.getpos()}")

parser = MyHTMLParser()
with open('app/static/index.html') as f:
    parser.feed(f.read())

for err in parser.errors:
    print(err)
if parser.stack:
    print("Unclosed tags:", parser.stack)
